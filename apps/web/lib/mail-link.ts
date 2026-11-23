import { Link } from "@mantine/tiptap";

// ss2i : lien de l'editeur du mail. Le Link de TipTap est « inclusive » des que l'autolink
// est actif : apres une adresse liee automatiquement (dev@ss2i-services.fr), tout le reste de
// la ligne tapee a la suite devenait lien. Non inclusif, le lien s'arrete a son dernier
// caractere ; l'autolink et le lien pose par le bouton ou Mod-K restent inchanges.
export const MailLink = Link.extend({
	inclusive() {
		return false;
	},
});
