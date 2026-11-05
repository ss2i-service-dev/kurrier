// Skeletons shown while loading, instead of a full-screen spinner.
import React from "react";

const bar = "rounded bg-k-hover animate-pulse";

export function ListSkeleton() {
	return (
		<div className="px-3 pt-1">
			<div className={`${bar} mb-4 mt-3 h-4 w-40`} />
			{Array.from({ length: 9 }).map((_, i) => (
				<div key={i} className="flex gap-3 px-1.5 py-3">
					<div className={`${bar} h-8 w-8 shrink-0 rounded-full`} />
					<div className="flex-1 space-y-2">
						<div className="flex justify-between">
							<div className={`${bar} h-3 w-32`} />
							<div className={`${bar} h-3 w-10`} />
						</div>
						<div className={`${bar} h-3 w-[85%]`} />
						<div className={`${bar} h-3 w-[60%]`} />
					</div>
				</div>
			))}
		</div>
	);
}

export function ReaderSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="h-12 shrink-0 border-b border-k-line" />
			<div className="w-full px-5 pt-6 md:px-8">
				<div className={`${bar} h-6 w-2/3`} />
				<div className={`${bar} mt-3 h-3 w-40`} />
				<div className="mt-8 flex gap-3">
					<div className={`${bar} h-[34px] w-[34px] shrink-0 rounded-full`} />
					<div className="flex-1 space-y-2 pt-1">
						<div className={`${bar} h-3 w-48`} />
						<div className={`${bar} h-3 w-32`} />
					</div>
				</div>
				<div className="mt-6 space-y-3">
					<div className={`${bar} h-3 w-full`} />
					<div className={`${bar} h-3 w-[92%]`} />
					<div className={`${bar} h-3 w-[75%]`} />
				</div>
			</div>
		</div>
	);
}
