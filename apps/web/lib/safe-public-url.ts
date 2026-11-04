import { assertPublicUrl } from "@common/safe-http";

// ss2i : les URL de desinscription viennent d'en-tetes de courriers non sollicites : le
// serveur ne doit jamais les suivre vers son reseau interne (SSRF). https seulement, et
// toutes les adresses du nom doivent etre publiques. La regle et l'envoi (adresse
// reverifiee a la connexion, contre le rebinding DNS) sont dans @common/safe-http.
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
	try {
		return await assertPublicUrl(raw);
	} catch (e: any) {
		throw new Error(`Unsubscribe URL rejected: ${e?.message ?? e}`);
	}
}
