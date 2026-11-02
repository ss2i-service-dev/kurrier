// Environnement du test des clients : les identites des fixtures (@test.invalid) sont
// « pro » et internes, et aucun jeton CRM (le cache d'adresses suffit). Importe en
// premier : les modules lisent l'environnement a leur chargement.
process.env.CRM_PRO_DOMAINS = "test.invalid";
process.env.CRM_INTERNAL_DOMAINS = "test.invalid";
delete process.env.CRM_LORE_TOKEN;
