import { defineEventHandler, setResponseHeader, setResponseStatus } from "h3";

// No server-side session: nothing to terminate (the protocol allows a 405 here).
export default defineEventHandler((event) => {
	setResponseStatus(event, 405);
	setResponseHeader(event, "Allow", "POST");
	return { error: "method_not_allowed", message: "Stateless server: no session to delete" };
});
