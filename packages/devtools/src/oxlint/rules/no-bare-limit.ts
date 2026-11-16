import { Array as Arr, Option, String as Str } from "effect"
import { isLimitsExempt, LimitsOptions, packagesOf } from "#oxlint/limits.ts"
import { type AnyNode, type Context, configured, type NodeOf } from "#oxlint/rule.ts"
import { ancestorsOf, calleeNameOf } from "#oxlint/syntax.ts"

/** Whether a governed place holds a time, where 1 is a limit too (one unit of time is a choice), or a count. */
type Measure = "time" | "count"

/** Each time unit, as a name or a duration string spells it, with its length in nanoseconds. */
const TIME_UNITS: ReadonlyMap<string, number> = new Map([
	["nano", 1],
	["nanos", 1],
	["nanosecond", 1],
	["nanoseconds", 1],
	["micro", 1e3],
	["micros", 1e3],
	["microsecond", 1e3],
	["microseconds", 1e3],
	["milli", 1e6],
	["millis", 1e6],
	["millisecond", 1e6],
	["milliseconds", 1e6],
	["ms", 1e6],
	["sec", 1e9],
	["secs", 1e9],
	["second", 1e9],
	["seconds", 1e9],
	["minute", 6e10],
	["minutes", 6e10],
	["mins", 6e10],
	["hour", 3.6e12],
	["hours", 3.6e12],
	["day", 8.64e13],
	["days", 8.64e13],
	["week", 6.048e14],
	["weeks", 6.048e14]
])

/** Words that name a time wherever they stand in a name, beside the units. */
const TIME_WORDS: ReadonlyArray<string> = [
	"timeout",
	"timeouts",
	"interval",
	"intervals",
	"delay",
	"delays",
	"ttl",
	"deadline",
	"deadlines",
	"grace",
	"backoff"
]

/** Words that name a count's bound wherever they stand in a name. */
const COUNT_WORDS: ReadonlyArray<string> = [
	"concurrency",
	"parallelism",
	"permits",
	"retries",
	"retry",
	"attempts",
	"times",
	"max",
	"min",
	"limit",
	"limits",
	"cap",
	"capacity",
	"threshold",
	"budget",
	"budgets",
	"batch",
	"page",
	"pool",
	"window"
]

/** A name split into its words, lower case: `maxRetries`, `MAX_RETRIES` and `HTTPTimeoutMs` read as `max retries` and
 * `http timeout ms`. */
const wordsOf = (name: string): ReadonlyArray<string> => {
	const words: Array<string> = []
	let word = ""
	const chars = Array.from(name)
	const isDigit = (char: string): boolean => char >= "0" && char <= "9"
	const isUpper = (char: string): boolean => char !== Str.toLowerCase(char)
	const isLower = (char: string): boolean => char !== Str.toUpperCase(char)
	Arr.forEach(chars, (char, at) => {
		if (!isUpper(char) && !isLower(char) && !isDigit(char)) {
			words.push(word)
			word = ""
			return
		}
		const previous = chars[at - 1] ?? ""
		const next = chars[at + 1] ?? ""
		if (
			isUpper(char) &&
			(isLower(previous) || isDigit(previous) || (isUpper(previous) && isLower(next)))
		) {
			words.push(word)
			word = ""
		}
		word += Str.toLowerCase(char)
	})
	words.push(word)
	return Arr.filter(words, (each) => each !== "")
}

/** What a name says it bounds: a time, a count, or nothing. */
const measureOfName = (name: string): Option.Option<Measure> => {
	const words = wordsOf(name)
	if (Arr.some(words, (word) => TIME_UNITS.has(word) || Arr.contains(TIME_WORDS, word))) {
		return Option.some("time")
	}
	return Arr.some(words, (word) => Arr.contains(COUNT_WORDS, word))
		? Option.some("count")
		: Option.none()
}

/**
 * The exact ratio a unit conversion's name states: two time units (`daySeconds`, the seconds in a day) or one per another
 * (`millisPerSecond`). A conversion that holds it is no limit.
 */
const conversionOf = (name: string): Option.Option<number> => {
	const words = wordsOf(name)
	const [first = "", second = "", third = ""] = words
	if (words.length === 2 && TIME_UNITS.has(first) && TIME_UNITS.has(second)) {
		return Option.some((TIME_UNITS.get(first) ?? 0) / (TIME_UNITS.get(second) ?? 1))
	}
	if (words.length === 3 && second === "per" && TIME_UNITS.has(first) && TIME_UNITS.has(third)) {
		return Option.some((TIME_UNITS.get(third) ?? 0) / (TIME_UNITS.get(first) ?? 1))
	}
	return Option.none()
}

/** The value an expression of numeric literals alone folds to, or none for one that reads anything else. */
const foldOf = (node: AnyNode): Option.Option<number> => {
	if (node.type === "Literal") {
		if (typeof node.value === "number") {
			return Option.some(node.value)
		}
		return typeof node.value === "bigint" ? Option.some(Number(node.value)) : Option.none()
	}
	if (node.type === "UnaryExpression") {
		if (node.operator === "-") {
			return Option.map(foldOf(node.argument), (value) => -value)
		}
		return node.operator === "+" ? foldOf(node.argument) : Option.none()
	}
	if (node.type === "BinaryExpression") {
		const { left, right, operator } = node
		return Option.flatMap(foldOf(left), (l) =>
			Option.flatMap(foldOf(right), (r) => arithmetic(operator, l, r))
		)
	}
	if (
		node.type === "TSAsExpression" ||
		node.type === "TSSatisfiesExpression" ||
		node.type === "TSNonNullExpression"
	) {
		return foldOf(node.expression)
	}
	return Option.none()
}

/** One arithmetic step of a fold, none for an operator that is no arithmetic. */
const arithmetic = (operator: string, left: number, right: number): Option.Option<number> => {
	switch (operator) {
		case "+":
			return Option.some(left + right)
		case "-":
			return Option.some(left - right)
		case "*":
			return Option.some(left * right)
		case "/":
			return Option.some(left / right)
		case "%":
			return Option.some(left % right)
		case "**":
			return Option.some(left ** right)
		default:
			return Option.none()
	}
}

/** Operators whose literal side is a factor that scales, shifts, masks or reduces data: no limit. */
const FACTOR_OPERATORS: ReadonlyArray<string> = [
	"*",
	"/",
	"%",
	"**",
	"<<",
	">>",
	">>>",
	"&",
	"|",
	"^"
]

/** A data length: `xs.length`, `set.size`, `bytes.byteLength`. Index arithmetic against one is no limit. */
const isDataLength = (node: AnyNode): boolean =>
	node.type === "MemberExpression" &&
	!node.computed &&
	node.property.type === "Identifier" &&
	Arr.contains(["length", "size", "byteLength"], node.property.name)

/** A number written in hexadecimal, binary or octal: a code unit or a bit pattern, no limit. */
const isBitPattern = (node: AnyNode): boolean =>
	node.type === "Literal" &&
	typeof node.raw === "string" &&
	Arr.some(["0x", "0X", "0b", "0B", "0o", "0O"], (prefix) => Str.startsWith(prefix)(node.raw ?? ""))

/** A literal value that is no limit wherever it stands: 0, 1 where it counts (one unit of time is a choice), a bit
 * pattern. */
const isIdentity = (node: AnyNode, value: number, measure: Measure): boolean =>
	value === 0 || (value === 1 && measure === "count") || isBitPattern(node)

/** A number in a governed place: the literal, and the constant that holds it when it stands elsewhere. */
type Bare = Readonly<{ node: AnyNode; held: Option.Option<string> }>

/** A use of a same-file constant in a governed place, judged once every declaration is read. */
type Use = Readonly<{ node: NodeOf<"Identifier">; measure: Measure }>

/** A same-file `const` with an initializer, as a governed place may read it. */
type Constant = Readonly<{ init: AnyNode; governed: boolean; exempt: boolean }>

/** Calls whose arguments are times, by the name the code calls them by. */
const isTimeCall = (name: string): boolean => {
	const [object, method] = Option.match(Str.indexOf(".")(name), {
		onNone: () => ["", name] as const,
		onSome: (dot) => [Str.slice(0, dot)(name), Str.slice(dot + 1)(name)] as const
	})
	return (
		(object === "Duration" && TIME_UNITS.has(method)) ||
		(object === "Schedule" &&
			Arr.contains(["spaced", "fixed", "windowed", "exponential"], method)) ||
		(object === "Effect" &&
			(Str.startsWith("timeout")(method) || method === "delay" || method === "sleep")) ||
		name === "AbortSignal.timeout" ||
		name === "setTimeout" ||
		name === "setInterval" ||
		method === "setTimeout" ||
		method === "setInterval"
	)
}

/** Calls whose arguments are counts: a retry's recurrences, a concurrency, a semaphore's permits. */
const COUNT_CALLS: ReadonlyArray<string> = [
	"Schedule.recurs",
	"Effect.withConcurrency",
	"Effect.makeSemaphore",
	"Effect.makeSemaphoreUnsafe",
	"Effect.unsafeMakeSemaphore",
	"Semaphore.make",
	"Semaphore.makeUnsafe",
	"TxSemaphore.make"
]

/** Calls a governed value passes through: a clamp, a conversion, an option. */
const THROUGH_CALLS: ReadonlyArray<string> = [
	"Math.min",
	"Math.max",
	"BigInt",
	"Number",
	"Option.some"
]

/** The units of a duration as text, as Effect's Duration.Unit spells them. */
const DURATION_UNITS: ReadonlyArray<string> = [
	"nano",
	"nanos",
	"micro",
	"micros",
	"milli",
	"millis",
	"second",
	"seconds",
	"minute",
	"minutes",
	"hour",
	"hours",
	"day",
	"days",
	"week",
	"weeks"
]

/** A duration as text, `${number} ${unit}` as Effect's Duration.Input reads it, by its number. */
const durationTextOf = (text: string): Option.Option<number> => {
	const parts = Str.split(" ")(text)
	const [amount] = parts
	if (parts.length !== 2 || Str.isEmpty(amount)) {
		return Option.none()
	}
	return Option.flatMap(Arr.get(parts, 1), (unit) => {
		const value = Number(amount)
		return Arr.contains(DURATION_UNITS, unit) && !Number.isNaN(value)
			? Option.some(value)
			: Option.none()
	})
}

/** The type a declaration annotates its binding with, when it is a closed vocabulary: a literal type or a union of
 * them (`0 | 1 | 2`). A value of a closed vocabulary is no limit. */
const isClosedVocabulary = (binding: AnyNode): boolean => {
	if (binding.type !== "Identifier" && binding.type !== "PropertyDefinition") {
		return false
	}
	const annotation = binding.typeAnnotation
	if (annotation === null || annotation === undefined) {
		return false
	}
	const type = annotation.typeAnnotation
	return (
		type.type === "TSLiteralType" ||
		(type.type === "TSUnionType" &&
			Arr.every(type.types, (member) => member.type === "TSLiteralType"))
	)
}

/** Whether the JSDoc of a declaration, or of the declaration that holds it (a layout's slots), names it a format's
 * defining width with `@formatConstant`, which is no limit. */
const isFormatConstant = (context: Context, node: AnyNode): boolean =>
	Arr.some(
		Arr.filter([node, ...ancestorsOf(node)], (holder) => holder.type !== "Program"),
		(holder) =>
			Arr.some(context.sourceCode.getCommentsBefore(holder), (comment) =>
				Str.includes("@formatConstant")(comment.value)
			)
	)

/** The name a property's key spells: an identifier, a string, or a computed string (`["concurrency"]`); none for a
 * computed key that reads a variable. */
const keyNameOf = (key: AnyNode, computed: boolean): Option.Option<string> => {
	if (key.type === "Identifier" && !computed) {
		return Option.some(key.name)
	}
	return key.type === "Literal" && typeof key.value === "string"
		? Option.some(key.value)
		: Option.none()
}

/**
 * A number written where a limit belongs, outside the repository's limits packages: in the value of a property,
 * variable, parameter default, class field, assignment or JSX attribute whose name says it bounds a time or a count
 * (`timeoutMs`, `concurrency`, `maxRetries`, `pageSize`, `ttl`); in the arguments of Duration's constructors,
 * Schedule.spaced, fixed, exponential, windowed and recurs, Effect.timeout*, delay, sleep and withConcurrency, a
 * semaphore's permits, setTimeout and setInterval, and AbortSignal.timeout; and in a duration as text ("5 seconds").
 * A same-file constant that holds a number and stands in such a place is the number. The rule reads syntax alone.
 *
 * What is no limit passes: 0; 1 where it counts, but not as a time, since one unit of time is a choice; a factor that
 * scales, shifts, masks or reduces (`ms * 1000`, `bits & 0xff`); an offset of a data length (`xs.length - 2`); a number
 * written in hexadecimal, binary or octal; a unit conversion that holds its exact ratio (`millisPerSecond = 1000`); a
 * binding typed as a closed vocabulary (`0 | 1 | 2`); and a declaration whose JSDoc names a format's defining width with
 * `@formatConstant`. Comparisons are not read, so `-1` and a bound in a condition pass here; review holds those. Test
 * files and the limits packages are exempt.
 */
export const noBareLimit = configured(LimitsOptions, (context, options) => {
	if (isLimitsExempt(context, options)) {
		return {}
	}
	const where = packagesOf(options)
	const report = (bare: Bare): void => {
		context.report({
			node: bare.node,
			message: Option.match(bare.held, {
				onNone: () =>
					`A bare number where a limit belongs: mint it in the limits package, ${where}, as published, measured, derived or provisional, and read its .value here, or take it as the caller's input.`,
				onSome: (name) =>
					`${name} holds a bare number where a limit belongs: mint it in the limits package, ${where}, as published, measured, derived or provisional, and read its .value here, or take it as the caller's input.`
			})
		})
	}
	const constants = new Map<string, Constant>()
	const declaredTwice = new Set<string>()
	const uses: Array<Use> = []
	/** The bare numbers a governed value holds, the same-file constants it reads set aside for the end of the file. */
	const bareIn = (node: AnyNode, measure: Measure): ReadonlyArray<Bare> => {
		const folded = foldOf(node)
		if (Option.isSome(folded)) {
			return isIdentity(node, folded.value, measure) ? [] : [{ node, held: Option.none() }]
		}
		if (
			node.type === "TSAsExpression" ||
			node.type === "TSSatisfiesExpression" ||
			node.type === "TSNonNullExpression"
		) {
			return bareIn(node.expression, measure)
		}
		if (node.type === "ConditionalExpression") {
			return [...bareIn(node.consequent, measure), ...bareIn(node.alternate, measure)]
		}
		if (node.type === "LogicalExpression") {
			return [...bareIn(node.left, measure), ...bareIn(node.right, measure)]
		}
		if (node.type === "BinaryExpression" && node.left.type !== "PrivateIdentifier") {
			const { left, right, operator } = node
			if (Arr.contains(FACTOR_OPERATORS, operator)) {
				return [
					...(Option.isSome(foldOf(left)) ? [] : bareIn(left, measure)),
					...(Option.isSome(foldOf(right)) ? [] : bareIn(right, measure))
				]
			}
			const offsetOf = (side: AnyNode, other: AnyNode): ReadonlyArray<Bare> =>
				Option.isSome(foldOf(side)) && isDataLength(other) ? [] : bareIn(side, measure)
			return operator === "+" || operator === "-"
				? [...offsetOf(left, right), ...offsetOf(right, left)]
				: []
		}
		if (node.type === "CallExpression") {
			return Option.exists(calleeNameOf(node.callee), (name) => Arr.contains(THROUGH_CALLS, name))
				? Arr.flatMap(node.arguments, (argument) => bareIn(argument, measure))
				: []
		}
		if (node.type === "Identifier") {
			uses.push({ node, measure })
		}
		return []
	}
	const govern = (node: AnyNode, measure: Measure): void => {
		Arr.forEach(bareIn(node, measure), report)
	}
	/** A value under a name: governed when the name says it bounds something, unless what holds it is no limit. */
	const named = (name: string, value: AnyNode, exempt: boolean): void => {
		if (exempt) {
			return
		}
		const ratio = conversionOf(name)
		const folded = foldOf(value)
		if (Option.isSome(ratio) && Option.isSome(folded) && ratio.value === folded.value) {
			return
		}
		Option.match(measureOfName(name), {
			onNone: () => undefined,
			onSome: (measure) => {
				govern(value, measure)
			}
		})
	}
	return {
		VariableDeclarator: (node) => {
			if (node.id.type !== "Identifier" || node.init === null) {
				return
			}
			const name = node.id.name
			const exempt =
				isClosedVocabulary(node.id) ||
				(node.parent.type === "VariableDeclaration" && isFormatConstant(context, node.parent))
			if (node.parent.type === "VariableDeclaration" && node.parent.kind === "const") {
				if (constants.has(name)) {
					declaredTwice.add(name)
				}
				constants.set(name, {
					init: node.init,
					governed: Option.isSome(measureOfName(name)),
					exempt: exempt || Option.isSome(conversionOf(name))
				})
			}
			named(name, node.init, exempt)
		},
		Property: (node) => {
			if (node.parent.type !== "ObjectExpression" || node.kind !== "init" || node.method) {
				return
			}
			Option.match(keyNameOf(node.key, node.computed), {
				onNone: () => undefined,
				onSome: (name) => {
					named(name, node.value, isFormatConstant(context, node))
				}
			})
		},
		PropertyDefinition: (node) => {
			if (node.value === null) {
				return
			}
			const value = node.value
			Option.match(keyNameOf(node.key, node.computed), {
				onNone: () => undefined,
				onSome: (name) => {
					named(name, value, isClosedVocabulary(node) || isFormatConstant(context, node))
				}
			})
		},
		AssignmentPattern: (node) => {
			const key =
				node.parent.type === "Property"
					? keyNameOf(node.parent.key, node.parent.computed)
					: Option.none<string>()
			const name =
				node.left.type === "Identifier" ? Option.some(node.left.name) : Option.none<string>()
			Option.match(
				Option.orElse(name, () => key),
				{
					onNone: () => undefined,
					onSome: (found) => {
						named(found, node.right, isClosedVocabulary(node.left))
					}
				}
			)
		},
		AssignmentExpression: (node) => {
			if (node.operator !== "=") {
				return
			}
			const target = node.left
			if (target.type === "Identifier") {
				named(target.name, node.right, false)
			} else if (
				target.type === "MemberExpression" &&
				!target.computed &&
				target.property.type === "Identifier"
			) {
				named(target.property.name, node.right, false)
			}
		},
		JSXAttribute: (node) => {
			if (
				node.name.type === "JSXIdentifier" &&
				node.value?.type === "JSXExpressionContainer" &&
				node.value.expression.type !== "JSXEmptyExpression"
			) {
				named(node.name.name, node.value.expression, false)
			}
		},
		CallExpression: (node) => {
			Option.match(calleeNameOf(node.callee), {
				onNone: () => undefined,
				onSome: (name) => {
					if (name === "Schedule.exponential") {
						Arr.forEach(node.arguments, (argument, at) => {
							govern(argument, at === 0 ? "time" : "count")
						})
					} else if (isTimeCall(name)) {
						Arr.forEach(node.arguments, (argument) => {
							govern(argument, "time")
						})
					} else if (Arr.contains(COUNT_CALLS, name)) {
						Arr.forEach(node.arguments, (argument) => {
							govern(argument, "count")
						})
					}
				}
			})
		},
		Literal: (node) => {
			if (typeof node.value !== "string" || node.parent.type === "TSLiteralType") {
				return
			}
			Option.match(durationTextOf(node.value), {
				onNone: () => undefined,
				onSome: (value) => {
					if (value !== 0) {
						report({ node, held: Option.none() })
					}
				}
			})
		},
		TemplateLiteral: (node) => {
			const [quasi] = node.quasis
			if (
				node.expressions.length > 0 ||
				quasi === undefined ||
				node.parent.type === "TSLiteralType"
			) {
				return
			}
			Option.match(durationTextOf(quasi.value.cooked ?? quasi.value.raw), {
				onNone: () => undefined,
				onSome: (value) => {
					if (value !== 0) {
						report({ node, held: Option.none() })
					}
				}
			})
		},
		"Program:exit": () => {
			for (const use of uses) {
				const constant = constants.get(use.node.name)
				if (
					constant === undefined ||
					declaredTwice.has(use.node.name) ||
					constant.governed ||
					constant.exempt
				) {
					continue
				}
				const folded = foldOf(constant.init)
				if (Option.isSome(folded) && !isIdentity(constant.init, folded.value, use.measure)) {
					report({ node: use.node, held: Option.some(use.node.name) })
				}
			}
		}
	}
})
