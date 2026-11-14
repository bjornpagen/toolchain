export function DuplicateFixture() {
	return (
		<div className="flex">
			<span
				className="flex items-center flex" // violation
			/>
		</div>
	)
}
