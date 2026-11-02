import { defineEventHandler, setResponseHeader, setResponseStatus } from "h3";

// Pas de session cote serveur : rien a terminer (le protocole prevoit 405 ici).
export default defineEventHandler((event) => {
	setResponseStatus(event, 405);
	setResponseHeader(event, "Allow", "POST");
	return { error: "method_not_allowed", message: "Stateless server: no session to delete" };
});
