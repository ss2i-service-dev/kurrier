// "Every time I send a mail, it lands in my inbox as unread." The stored data was right (the
// copy received through an alias is stored read): it is the "arrived since read" marker of the
// list that relied on last_activity_at. A sent reply changes it (the thread moves up) and so does
// the copy received through the alias: the thread turned unread again on screen.
// Now only a message from someone else, arrived in this folder, lights the marker.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/own-reply-not-unread.ts
import assert from "node:assert/strict";
import { createArrivalTracker } from "../lib/arrival-tracker";

const own = new Set(["me@example.com"]);
const row = (count: number, lastFrom: string) => ({ count, lastFrom });

// 1) Thread open, I reply: the thread moves up (date changed), same number of messages here.
{
	const t = createArrivalTracker();
	assert.equal(t.arrived("A", row(2, "alice@example.org"), own, true), false);
	assert.equal(t.arrived("A", row(2, "alice@example.org"), own, false), false, "sent reply: no marker");
}

// 2) My copy comes back through an alias into the inbox: one more message, from me.
{
	const t = createArrivalTracker();
	t.arrived("B", row(2, "alice@example.org"), own, true);
	assert.equal(t.arrived("B", row(3, "Me@Example.com"), own, false), false, "my copy: no marker");
}

// 3) A colleague replies while the thread is open: marker, and it stays until the next read.
{
	const t = createArrivalTracker();
	t.arrived("C", row(2, "alice@example.org"), own, true);
	assert.equal(t.arrived("C", row(3, "bob@example.net"), own, false), true);
	assert.equal(t.arrived("C", row(3, "bob@example.net"), own, false), true, "marker kept");
	assert.equal(t.arrived("C", row(4, "me@example.com"), own, false), true, "my reply does not clear it");
	t.reset("C");
	assert.equal(t.arrived("C", row(4, "me@example.com"), own, true), false, "read: no marker");
}

// 4) Thread never opened: no tracking, nothing to report (the unread state comes from the server).
{
	const t = createArrivalTracker();
	assert.equal(t.arrived("D", row(1, "x@example.org"), own, false), false);
	assert.equal(t.arrived("D", row(2, "x@example.org"), own, false), false);
}

// 5) A message leaves the folder (archive) then another arrives: count is taken back down.
{
	const t = createArrivalTracker();
	t.arrived("E", row(3, "x@example.org"), own, true);
	assert.equal(t.arrived("E", row(2, "x@example.org"), own, false), false);
	assert.equal(t.arrived("E", row(3, "z@example.org"), own, false), true);
}

console.log("own-reply-not-unread: ok");
