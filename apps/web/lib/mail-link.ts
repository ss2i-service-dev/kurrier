import { Link } from "@mantine/tiptap";

// Link mark of the mail editor. TipTap's Link is "inclusive" as soon as autolink is on: after
// an address linked automatically, everything typed next on the line became part of the link.
// Not inclusive, the link ends at its last character; autolink and the link set by the button
// or Mod-K are unchanged.
export const MailLink = Link.extend({
	inclusive() {
		return false;
	},
});
