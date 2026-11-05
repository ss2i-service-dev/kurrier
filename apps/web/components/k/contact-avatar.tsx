// Contact avatar (photo if there is one, otherwise initials).
import React from "react";
import KAvatar from "@/components/k/avatar";

export default function KContactAvatar({
	name,
	email,
	url,
	size = 36,
}: {
	name?: string | null;
	email?: string | null;
	url?: string | null;
	size?: number;
}) {
	if (!url) return <KAvatar name={name} email={email || name} size={size} />;
	return (
		// eslint-disable-next-line @next/next/no-img-element
		<img
			src={url}
			alt=""
			width={size}
			height={size}
			className="shrink-0 rounded-full object-cover object-top"
			style={{ width: size, height: size }}
		/>
	);
}
