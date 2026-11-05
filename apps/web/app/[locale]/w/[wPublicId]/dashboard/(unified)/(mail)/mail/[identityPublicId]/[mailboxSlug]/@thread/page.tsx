// Without a page here, an in-app navigation to the list (closing a thread) leaves
// the @thread slot on the previous thread (Next's parallel routes behaviour); the
// next refresh then no longer matches and Next reloads the whole page. An empty
// page really closes the thread. Renders the same as default.tsx (nothing) in both
// interfaces.
export default function NoThread() {
	return null;
}
