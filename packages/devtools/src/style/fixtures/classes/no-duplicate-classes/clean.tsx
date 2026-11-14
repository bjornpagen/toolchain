import { cn } from "#fixture/cn.ts"

export function SingleFixture({ active }: Readonly<{ active: boolean }>) {
	return (
		<div className="flex items-center">
			<span className={cn("flex", active && "flex")} />
		</div>
	)
}
