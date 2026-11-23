"use client";
import { useLayoutEffect, useRef } from "react";

// The top bar of the classic interface (search, identity) is sticky and its height varies
// (74 px on desktop, more on a narrow screen). The bars stuck under it (list actions, thread
// back bar on mobile) read its height in --mail-header-h, kept up to date here. Without this
// offset they stuck at top-0, hence under the top bar, and their controls disappeared on the
// first scroll.
export const MAIL_HEADER_VAR = "--mail-header-h";

export default function MailHeaderHeight() {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const header = ref.current?.parentElement;
		if (!header) return;
		const root = document.documentElement;
		const apply = () => root.style.setProperty(MAIL_HEADER_VAR, `${header.getBoundingClientRect().height}px`);
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(header);
		return () => {
			ro.disconnect();
			root.style.removeProperty(MAIL_HEADER_VAR);
		};
	}, []);
	return <span ref={ref} hidden={true} />;
}
