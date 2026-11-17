import { Effect, Option } from "effect"
import { strictEqual } from "#assert.ts"
import {
	type Branch,
	branch,
	type Observation,
	type OutcomeFeature,
	type ReactiveMachine,
	type ReactiveReal
} from "#commands.ts"
import { boolean, constant, type Gen, int, type Space, type Steered, steered } from "#gen.ts"
import { type Swarm, swarm } from "#swarm.ts"

export type AccountParameters = Readonly<{ deposit: number; withdraw: number }>

export type AccountRule = keyof AccountParameters

const ACCOUNT_RULES: readonly [AccountRule, AccountRule] = ["deposit", "withdraw"]

/**
 * What an account's observation names: a deposit credited; a withdrawal paid that leaves the account holding something
 * (debited) or nothing (emptied), or refused as more than it holds.
 */
export type AccountOutcome = "credited" | "debited" | "emptied" | "refused"

export type AccountFeature = OutcomeFeature<AccountParameters, AccountOutcome>

/** Every step feature of the account's model, the emptied withdrawal the rare one. */
export const ACCOUNT_FEATURES: readonly [AccountFeature, ...Array<AccountFeature>] = [
	"deposit credited",
	"withdraw debited",
	"withdraw emptied",
	"withdraw refused"
]

/**
 * The amounts a deposit or a plain withdrawal draws, in whole cents: every value one decision holds (gen.ts `int`), so
 * a plain withdrawal names an account's exact balance about once in 2^32 draws.
 */
const AMOUNTS: Gen<number> = int(0, 2 ** 32 - 1)

/**
 * What every account opens with: a balance amid the amounts a withdrawal draws, so no edge of their range, nor any
 * value near one (what a mutant's simplest or extreme decision makes), is a balance a case reaches by its own draws.
 */
const OPENING = 2 ** 31

/**
 * How a case draws its withdrawals' amounts: from every amount, or each at the balance the account holds, aimed at
 * emptying it. A case's mix chooses it, so only a case its steering aims at an emptied withdrawal draws at the balance.
 */
export type Withdrawals = "drawn" | "at the balance"

/** What an account's model holds: its balance, and how its case draws its withdrawals, as the case's mix chose. */
export type Teller = Readonly<{ balance: number; withdrawals: Withdrawals }>

/** A withdrawal's amount, drawn as its case draws withdrawals, in the state the run reached. */
const withdrawalOf: Readonly<Record<Withdrawals, (balance: number) => Gen<number>>> = {
	drawn: () => AMOUNTS,
	"at the balance": (balance) => constant(balance)
}

/** The one outcome the model allows a withdrawal of `amount`: refused past the balance, otherwise paid. */
const withdrawn = (teller: Teller, amount: number): Branch<Teller, AccountOutcome, unknown> =>
	amount > teller.balance
		? branch("refused", teller)
		: branch(amount === teller.balance ? "emptied" : "debited", {
				...teller,
				balance: teller.balance - amount
			})

/**
 * An account as its model judges it: a deposit adds to the balance; a withdrawal of no more than the balance is paid,
 * emptying the account when it is exactly the balance, and one of more is refused, leaving it as it was.
 */
export const ACCOUNT: ReactiveMachine<Teller, AccountParameters, AccountOutcome, undefined> = {
	rules: {
		deposit: {
			weight: 1,
			applies: () => true,
			parameters: () => AMOUNTS,
			judge: (teller, amount) => [
				branch("credited", { ...teller, balance: teller.balance + amount })
			]
		},
		withdraw: {
			weight: 1,
			applies: () => true,
			parameters: (teller) => withdrawalOf[teller.withdrawals](teller.balance),
			judge: (teller, amount) => [withdrawn(teller, amount)]
		}
	}
}

/** What a reactive case of the account draws before its run: its swarm, and how it draws its withdrawals. */
export type AccountMix = Readonly<{ swarm: Swarm<AccountRule>; withdrawals: Withdrawals }>

/**
 * The account's steered mix: a case whose turn aims at an emptied withdrawal while it is pending (features.ts Pending
 * `aimed`, the steering an explored space reads) draws each withdrawal at the balance, and every other case draws its
 * withdrawals from every amount.
 */
export const accountMixes: Steered<AccountMix, AccountFeature> = steered(
	(steering) => (source) => ({
		swarm: source.draw(swarm(ACCOUNT_RULES)),
		withdrawals: Option.exists(steering, (pending) => pending.aimed("withdraw emptied"))
			? "at the balance"
			: "drawn"
	})
)

/** The account's mix drawn as no steering draws it: what a plain draw of the steered mix gives every case. */
export const plainMixes: Space<AccountMix> = accountMixes.under(Option.none())

/**
 * How an account answers a withdrawal of exactly what it holds: pays it, emptying itself, or refuses it as an overdraft,
 * an overdraft check off by one (`amount < balance` where `amount <= balance` is meant).
 */
export type Exact = "pays" | "refuses"

/** How an account is built: how it answers a withdrawal of exactly its balance. */
export type AccountBuild = Readonly<{ exact: Exact }>

/** The account built right. */
export const rightAccount: AccountBuild = { exact: "pays" }

/** Every way to build an account. */
export const accountBuilds: Gen<AccountBuild> = (source) => ({
	exact: source.draw(boolean) ? "refuses" : "pays"
})

/** Whether an account's balance covers a withdrawal, as each build checks it. */
const covers: Readonly<Record<Exact, (amount: number, balance: number) => boolean>> = {
	pays: (amount, balance) => amount <= balance,
	refuses: (amount, balance) => amount < balance
}

/** An account, the system under test, opened with OPENING and built as `build` says. */
export const accountOf = (build: AccountBuild) => {
	let balance = OPENING
	return {
		deposit: (amount: number): void => {
			balance += amount
		},
		withdraw: (amount: number): boolean => {
			if (!covers[build.exact](amount, balance)) {
				return false
			}
			balance -= amount
			return true
		},
		balance: (): number => balance
	}
}

/** An observation that names its outcome and shows nothing more. */
const observed = (outcome: AccountOutcome): Observation<AccountOutcome, undefined> => ({
	outcome,
	shown: undefined
})

/** The outcome of a withdrawal the account paid, by what it holds after it. */
const paid = (left: number): AccountOutcome => (left === 0 ? "emptied" : "debited")

/**
 * Each rule run on an account, which opens with OPENING, its model starting there with the withdrawals the case's mix
 * chose: a step acts and answers what the account did; `holds` checks the account's balance is the model's.
 */
export const accountReal = (
	account: ReturnType<typeof accountOf>,
	mix: AccountMix
): ReactiveReal<Teller, AccountParameters, AccountOutcome, undefined, never, never> => ({
	start: { balance: OPENING, withdrawals: mix.withdrawals },
	steps: {
		deposit: (amount) =>
			Effect.sync(() => {
				account.deposit(amount)
				return observed("credited")
			}),
		withdraw: (amount) =>
			Effect.sync(() => observed(account.withdraw(amount) ? paid(account.balance()) : "refused"))
	},
	holds: (after) =>
		Effect.sync(() => {
			strictEqual(account.balance(), after.balance)
		})
})

/** Whether an account is built right: it pays a withdrawal of exactly its balance. */
export const isRightAccount = (build: AccountBuild): boolean => build.exact === "pays"
