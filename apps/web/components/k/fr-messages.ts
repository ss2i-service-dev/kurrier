// SS2i : dictionnaire francais des notifications (toasts sonner) et messages
// renvoyes par les actions serveur, affiches dans la nouvelle interface (Outlook)
// uniquement. La classique garde l'anglais d'origine.
//
// - FR_EXACT : texte anglais exact -> francais ;
// - FR_PATTERNS : messages a partie variable. Le remplacement est une chaine au
//   format de String.prototype.replace ($1, $2...), sans fonction, pour rester
//   utilisable quel que soit l'appelant. Les motifs sont ancres (^...$).
// - FR_LABEL_NAMES : libelles systeme crees en base avec un nom anglais, traduits
//   a l'affichage seulement (la base n'est pas modifiee).

export const FR_EXACT: Record<string, string> = {
	// Recuperation des brouillons (patch 0077)
	"Unsaved draft recovered": "Brouillon non enregistré récupéré",
	"Open Drafts": "Ouvrir les brouillons",
	"A draft is waiting to be saved": "Un brouillon attend d'être enregistré",
	"Draft NOT saved on the server": "Brouillon NON enregistré sur le serveur",
	"The app was updated or restarted. Your text is kept in this browser: reload the page, it will be put back in Drafts automatically.":
		"L'application a été mise à jour ou redémarrée. Votre texte est conservé dans ce navigateur : rechargez la page, il sera remis automatiquement dans les brouillons.",
	"Reload": "Recharger",
	// Ordre des messages (patch 0080)
	"Conversations show the newest message at the top.": "Le message le plus récent s'affiche en haut des conversations.",
	"Conversations show the newest message at the bottom.": "Le message le plus récent s'affiche en bas des conversations.",
	// Generiques / reseau
	"Success": "Succès",
	"Error": "Erreur",
	"Done": "Terminé",
	"OK": "OK",
	"Saved": "Enregistré",
	"Deleted": "Supprimé",
	"Delete failed": "La suppression a échoué",
	"Unknown error": "Erreur inconnue",
	"Unexpected error": "Erreur inattendue",
	"Network error": "Erreur réseau",
	"Not authenticated": "Non authentifié",
	"Unauthorized": "Non autorisé",
	"Not found": "Introuvable",
	"Not implemented": "Non pris en charge pour le moment",
	"Invalid address": "Adresse invalide",
	"Invalid identity": "Identité invalide",
	"Invalid sender": "Expéditeur invalide",
	"Identity not found": "Identité introuvable",
	"Identity not found.": "Identité introuvable.",
	"Message not found": "Message introuvable",
	"Folder not found": "Dossier introuvable",
	"Invalid parent folder": "Dossier parent invalide",
	"Folder name is required": "Le nom du dossier est obligatoire",
	"Cannot delete a default folder": "Impossible de supprimer un dossier par défaut",
	"Archive folder could not be created": "Le dossier d'archives n'a pas pu être créé",
	"Action failed, messages restored": "L'action a échoué, les messages ont été rétablis",
	"Selection failed": "La sélection a échoué",
	"Could not save the preference": "Impossible d'enregistrer la préférence",
	"Workspace Updated": "Espace de travail mis à jour",
	"No workspace selected": "Aucun espace de travail sélectionné",
	"Workspace not found or no access": "Espace de travail introuvable ou accès refusé",
	"Default Workspace": "Espace de travail par défaut",
	"Missing workspace context.": "Espace de travail non précisé.",

	// Authentification
	"Logged in!": "Connexion réussie !",
	"Welcome!": "Bienvenue !",
	"Invalid credentials": "Identifiants invalides",
	"Missing email or password": "Adresse e-mail ou mot de passe manquant",
	"An account with this email already exists": "Un compte existe déjà avec cette adresse e-mail",
	"Signup is currently disabled. Please contact your administrator.":
		"Les inscriptions sont actuellement désactivées. Veuillez contacter votre administrateur.",
	"User registration is currently disabled. Please contact your administrator.":
		"Les inscriptions sont actuellement désactivées. Veuillez contacter votre administrateur.",

	// Envoi, brouillons, programmation
	"Message sent": "Message envoyé",
	"Sending failed": "L'envoi a échoué",
	"Sending…": "Envoi…",
	"Sending cancelled": "Envoi annulé",
	"Already sent": "Déjà envoyé",
	"Draft discarded": "Brouillon supprimé",
	"Draft could not be saved.": "Le brouillon n'a pas pu être enregistré.",
	"Cannot send mail: Workspace storage limit exceeded.":
		"Envoi impossible : la limite de stockage de l'espace de travail est dépassée.",
	"Required mailboxes (inbox and sent) not found for the identity.":
		"Les dossiers requis (boîte de réception et envoyés) sont introuvables pour cette identité.",
	"Required folders (inbox and sent) not found for this identity":
		"Les dossiers requis (boîte de réception et envoyés) sont introuvables pour cette identité",
	"Please provide at least one recipient in the To field.":
		"Veuillez indiquer au moins un destinataire dans le champ À.",
	"Invalid scheduled time.": "Date d'envoi programmé invalide.",
	"There was an error trying to schedule your mail.":
		"Une erreur est survenue lors de la programmation de l'envoi.",
	"Failed to schedule your mail.": "La programmation de l'envoi a échoué.",
	"Marked as unread": "Marqué comme non lu",
	"Mark as unread failed": "Impossible de marquer comme non lu",
	"Already in this folder": "Déjà dans ce dossier",
	"No message here looks legitimate": "Aucun message ne semble légitime ici",
	"Trash removed successfully": "Corbeille vidée",
	"Signature saved": "Signature enregistrée",

	// Expediteurs, desinscription
	"Cannot block one of your own addresses": "Impossible de bloquer l'une de vos propres adresses",
	"Unblock failed": "Le déblocage a échoué",
	"Block failed": "Échec du blocage",
	"Unsubscribed": "Désinscription effectuée",
	"Update failed": "Échec de la mise à jour",
	"Unsubscribe failed": "Échec de la désinscription",
	"Finish on the sender's page": "À terminer sur la page de l'expéditeur",
	"Subscription not found": "Abonnement introuvable",
	"No unsubscribe method in this message": "Aucun moyen de désinscription dans ce message",
	"Invalid unsubscribe address": "Adresse de désinscription invalide",
	"Too many redirects from the unsubscribe server": "Trop de redirections du serveur de désinscription",

	// Reponse automatique
	"Auto-reply enabled.": "Réponse automatique activée.",
	"Auto-reply saved.": "Réponse automatique enregistrée.",
	"The auto-reply message cannot be empty.": "Le message de réponse automatique ne peut pas être vide.",
	"Auto-reply is only available for IMAP/SMTP identities":
		"La réponse automatique n'est disponible que pour les identités IMAP/SMTP",
	"Mailbox credentials not found": "Identifiants de la boîte aux lettres introuvables",
	"No JMAP account for this mailbox": "Aucun compte JMAP pour cette boîte aux lettres",

	// Regles
	"Failed to create rule": "La création de la règle a échoué",
	"Rule not found": "Règle introuvable",
	"Missing ruleId": "Identifiant de règle manquant",
	"A rule with this name already exists for this identity.":
		"Une règle portant ce nom existe déjà pour cette identité.",
	"Rule name must be unique per identity.": "Le nom de la règle doit être unique pour chaque identité.",
	"Rule name is required.": "Le nom de la règle est obligatoire.",
	"Priority must be a non-negative number.": "La priorité doit être un nombre positif ou nul.",
	"Add at least one criteria field.": "Ajoutez au moins un critère.",
	"Select at least one action.": "Sélectionnez au moins une action.",
	"Label ID is required when Apply label is enabled.":
		"Le libellé est obligatoire lorsque « Appliquer un libellé » est activé.",
	"Validation errors occurred.": "Des erreurs de validation sont survenues.",

	// Libelles, contacts, clients
	"Label updated": "Libellé mis à jour",
	"Label deleted": "Libellé supprimé",

	// Drive, volumes, envoi de fichiers
	"Folder created": "Dossier créé",
	"Deleted folder": "Dossier supprimé",
	"Deleted file": "Fichier supprimé",
	"Folder deleted": "Dossier supprimé",
	"Folder name is required.": "Le nom du dossier est obligatoire.",
	"Missing volume": "Volume manquant",
	"Volume not found": "Volume introuvable",
	"Invalid volume type": "Type de volume invalide",
	"Cloud volume missing bucket": "Le volume cloud n'a pas de bucket",
	"Missing bucket in volume metaData": "Bucket manquant dans les métadonnées du volume",
	"Missing driveVolume": "Volume du Drive manquant",
	"Not signed in": "Non connecté",
	"Missing filename": "Nom de fichier manquant",
	"Missing drive entry": "Élément du Drive manquant",
	"Missing bucket or key": "Bucket ou clé manquant",
	"Invalid file path": "Chemin de fichier invalide",
	"Invalid folder path": "Chemin de dossier invalide",
	"Bucket is required": "Le bucket est obligatoire",
	"Bucket already exists": "Le bucket existe déjà",
	"Bucket created": "Bucket créé",
	"Volume name is required": "Le nom du volume est obligatoire",
	"Invalid volume name": "Nom de volume invalide",
	"S3_BUCKET is not configured": "S3_BUCKET n'est pas configuré",
	"Added new volume": "Volume ajouté",
	"Upload failed": "Échec de l'envoi",
	"Download failed": "Le téléchargement a échoué",
	"Failed to persist calendar event": "L'événement n'a pas pu être enregistré",
	"Missing calendarId": "Agenda non précisé",

	// Plateforme : fournisseurs, identites, domaines
	"Successfully updated provider account": "Compte du fournisseur mis à jour",
	"Deleted SMTP account": "Compte SMTP supprimé",
	"SMTP account deleted": "Compte SMTP supprimé",
	"SMTP connection verified": "Connexion SMTP vérifiée",
	"SMTP verification failed": "Échec de la vérification SMTP",
	"IMAP connection verified": "Connexion IMAP vérifiée",
	"IMAP verification failed": "Échec de la vérification IMAP",
	"Verification error": "Erreur de vérification",
	"Unexpected error while testing the account.": "Erreur inattendue pendant le test du compte.",
	"Unexpected error during SMTP/IMAP test.": "Erreur inattendue pendant le test SMTP/IMAP.",
	"Domain identity initialized": "Identité de domaine initialisée",
	"Domain identity deleted": "Identité de domaine supprimée",
	"Domain verification failed": "Échec de la vérification du domaine",
	"Failed to delete domain identity": "La suppression de l'identité de domaine a échoué",
	"Failed to delete domain identity.": "La suppression de l'identité de domaine a échoué.",
	"Failed to delete identity": "La suppression de l'identité a échoué",
	"Failed to delete identity.": "La suppression de l'identité a échoué.",
	"Failed to add new identity": "L'ajout de l'identité a échoué",
	"Failed to initialize email identity": "L'initialisation de l'identité e-mail a échoué",
	"Added new identity": "Identité ajoutée",
	"Deleted email identity": "Identité e-mail supprimée",
	"Must assign at least one member": "Vous devez attribuer au moins un membre",
	"No provider secret found for this selection": "Aucun secret de fournisseur trouvé pour cette sélection",
	"Unsupported provider type or missing provider": "Type de fournisseur non pris en charge ou fournisseur manquant",
	"Provider not supported yet.": "Fournisseur pas encore pris en charge.",
	"Test email sent successfully.": "Message de test envoyé.",
	"Cannot delete domain identity while email identities are still using it. Please delete associated email identities first.":
		"Impossible de supprimer l'identité de domaine tant que des identités e-mail l'utilisent. Supprimez d'abord les identités e-mail associées.",
	"Missing SES bootstrap resource IDs (bucket/topicArn/ruleSetName).":
		"Identifiants des ressources d'initialisation SES manquants (bucket, topicArn, ruleSetName).",
	"Postmark server verified": "Serveur Postmark vérifié",
	"Domain not found in Postmark account.": "Domaine introuvable dans le compte Postmark.",
	"IdentityNotFound": "Identité introuvable",

	// Cles d'API, webhooks, synchronisation
	"API key created successfully": "Clé d'API créée",
	"Copied API key": "Clé d'API copiée",
	"Webhook created successfully": "Webhook créé",
	"Failed to create webhook": "La création du webhook a échoué",

	// Formulaires (validation)
	"ULID is required": "L'identifiant est obligatoire",
	"Account label is required": "Le libellé du compte est obligatoire",
	"Provider selection is required": "Le choix du fournisseur est obligatoire",
	"Domain name is required": "Le nom de domaine est obligatoire",
	"Must be a valid domain (e.g. example.com)": "Doit être un domaine valide (ex. exemple.com)",
	"Must be a valid subdomain (e.g. mail.example.com or mail)":
		"Doit être un sous-domaine valide (ex. mail.exemple.com ou mail)",
	"ProviderId is required": "Le fournisseur est obligatoire",
	"Value is required": "La valeur est obligatoire",
	"Either 'html' or 'text' must be provided.": "Le contenu « html » ou « text » doit être fourni.",
	"Only authorization_code and refresh_token are supported":
		"Seuls authorization_code et refresh_token sont pris en charge",
};

export const FR_PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
	// Recuperation des brouillons (patch 0077)
	[/^« (.*) » is back in Drafts with everything you typed\.$/, "« $1 » est de retour dans les brouillons, avec tout ce que vous aviez saisi."],
	[/^« (.*) » is kept in this browser and will be retried\. ?(.*)$/, "« $1 » est conservé dans ce navigateur et sera renvoyé. $2"],
	[/^(.*) Your text is kept in this browser and will be put back in Drafts after a reload\.$/, "$1 Votre texte est conservé dans ce navigateur et sera remis dans les brouillons après un rechargement."],
	// Reseau, HTTP
	[/^Upload failed: (\d+)$/, "Échec de l'envoi : $1"],
	[/^HTTP (\d+)$/, "Erreur HTTP $1"],
	[/^Upload failed: (.+)$/, "Échec de l'envoi : $1"],

	// Contacts, copie, variable
	[/^(.+) added to your contacts$/, "$1 ajouté à vos contacts"],
	[/^Copied (.+)$/, "$1 copié"],
	[/^Nothing to copy for (.+)$/, "Rien à copier pour $1"],
	[/^Saved (.+)$/, "$1 enregistré"],
	[/^Deleted (.+)$/, "$1 supprimé"],
	[/^Unblocked (.+)$/, "$1 débloqué"],
	[/^Blocked (.+)$/, "$1 bloqué"],
	[/^Unsubscribed from (.+)$/, "Désinscription de $1"],
	[/^(\d+) message\(s\) selected, check them before moving$/, "$1 message(s) sélectionné(s), vérifiez avant de déplacer"],
	[/^(\d+) messages? moved to (.+)$/, "$1 message(s) déplacé(s) vers $2"],
	[/^Moved to (.+)$/, "Déplacé vers $1"],
	[/^(SMTP|IMAP|SES|POSTMARK|SENDGRID|MAILGUN) verification failed$/i, "Échec de la vérification $1"],
	[/^(SMTP|IMAP|SES|POSTMARK|SENDGRID|MAILGUN) connection verified$/i, "Connexion $1 vérifiée"],

	// Erreurs serveur avec detail
	[/^Cannot block the domain (.+): block the address instead$/, "Impossible de bloquer le domaine $1 : bloquez plutôt l'adresse"],
	[/^Unsupported calendar view: (.+)$/, "Vue d'agenda non prise en charge : $1"],
	[/^Identity not found: identity=(.+) slug=(.+)$/, "Identité introuvable : identité $1, dossier $2"],
	[/^Mailbox not found: identity=(.+) slug=(.+)$/, "Dossier introuvable : identité $1, dossier $2"],
	[/^Mail server refused the JMAP session \(HTTP (\d+)\)$/, "Le serveur de messagerie a refusé la session JMAP (HTTP $1)"],
	[/^JMAP request failed \(HTTP (\d+)\)$/, "La requête JMAP a échoué (HTTP $1)"],
	[/^JMAP error: (.+)$/, "Erreur JMAP : $1"],
	[/^Mail server rejected the change: (.+)$/, "Le serveur de messagerie a rejeté la modification : $1"],
	[/^Unsubscribe server answered HTTP (\d+)$/, "Le serveur de désinscription a répondu HTTP $1"],
	[/^Unsubscribe server answered (\d+) without a location$/, "Le serveur de désinscription a répondu $1 sans adresse de redirection"],
	[/^Bucket exists in region (.+)\. Provider is set to (.+)\.$/, "Le bucket existe dans la région $1. Le fournisseur est réglé sur $2."],
	[/^(.+) is not configured$/, "$1 n'est pas configuré"],
	[/^(.+) must be a valid Postgres connection URL$/, "$1 doit être une URL de connexion Postgres valide"],
];

// Libelles systeme crees automatiquement en base avec un nom anglais.
export const FR_LABEL_NAMES: Record<string, string> = {
	"Favorite": "Favoris",
	"Favorites": "Favoris",
	"Starred": "Favoris",
	"Archive": "Archives",
	"Inbox": "Boîte de réception",
	"Sent": "Envoyés",
	"Drafts": "Brouillons",
	"Trash": "Corbeille",
	"Spam": "Spam",
	"Snoozed": "Reportés",
	"Scheduled": "Envois programmés",
};

/** Nom de libelle a afficher : traduit dans la nouvelle interface, tel quel sinon. */
export function frLabelName(name: string, nouvelle = true): string {
	return nouvelle ? (FR_LABEL_NAMES[name] ?? name) : name;
}
