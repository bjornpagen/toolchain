import { cva } from "class-variance-authority"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { cn } from "#fixture/cn.ts"

const sizes = cva("inline-flex", {
	variants: {
		size: {
			sm: "h-7 gap-1",
			lg: "h-9 gap-huge" // violation
		}
	},
	compoundVariants: [{ size: "sm", class: "px-tiny" }] // violation
})

const muted = twMerge(clsx("text-muted-foregrund")) // violation

const titleClass = "flex-1 line-thru" // violation

export function decorate(element: HTMLElement) {
	element.classList.add("flex", "gap-bogus") // violation
	element.classList.toggle("hidden", Boolean(muted))
}

export function UnresolvedFixture({ labelClassName }: Readonly<{ labelClassName?: string }>) {
	return (
		<div
			className="flex p-huge" // violation
		>
			<span
				className={cn("items-center", "bg-prmary")} // violation
			/>
			<span className={sizes({ size: "sm" })} />
			<span
				labelClassName="text-bogus" // violation
			/>
			<span className={cn(muted, titleClass, labelClassName)} />
		</div>
	)
}
