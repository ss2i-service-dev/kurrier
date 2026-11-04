// ss2i : point d'entree SERVEUR seulement (worker et actions serveur du web). Ces modules
// utilisent la base en acces administrateur (@db) et l'API CRM : ils ne doivent jamais entrer
// dans l'index de @common, importe aussi par des composants du navigateur.
export * from "./crm-api";
export * from "./thread-client-link";
