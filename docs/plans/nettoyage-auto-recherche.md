# Règles de nettoyage automatique depuis une recherche

Demande de Samuel du 25/11/2026 : depuis une recherche, poser une règle permanente qui envoie à la Corbeille tout fil qui correspond et dont le message le plus récent dépasse une durée de conservation. Plan de découpage pour le skill `chantier-decoupe` : 14 micro-tâches, un commit vert chacune.

## 1. Décision

- **Table dédiée `cleanup_rules`, évaluation à l'âge au moment du tick.** Rien n'est écrit sur `mailbox_threads` : `expires_at`, son trigger et les invariants de `runExpiryTick` (échéance vidée hors Archive, ligne Inbox soeur) restent intacts et ne sont jamais lus par le nettoyage.
- **Un seul matcher** (`matchCleanup`, dans `@common`) sert au compte à la création et au tick : Typesense strict fournit des candidats, le SQL décide. Typesense n'est jamais l'arbitre : il peut être en retard, le SQL revérifie identité, dossier, âge du fil, étoile, snooze, filtres.
- **Recherche stricte** : `num_typos: 0`, `prefix: false`, `drop_tokens_threshold: 0`, `typo_tokens_threshold: 0`, `split_join_tokens: "off"`, `exhaustive_search: true` (noms vérifiés dans `/home/sam/dev/kurrier/node_modules/typesense/lib/Typesense/Types.d.ts`, client `typesense ^2.1.0`, serveur 29.0). Mêmes champs `query_by` que `initSearch`. Filtre sur `mailboxId` (UUID relus en base), jamais sur des slugs.
- **Dossiers nettoyables en allow-list** : `inbox`, `archive`, `custom`. Envoyés exclus (tranché : ce que l'utilisateur a écrit n'est pas du bruit reçu, et une réponse récente dans Envoyés doit au contraire retenir le fil), comme Corbeille, Spam, Brouillons, Boîte d'envoi et tout `kind` inconnu.
- **Âge du fil** = `last_activity_at` le plus récent de toutes les lignes `mailbox_threads` du fil dans l'identité, tous dossiers confondus (Envoyés et Brouillons compris : une réponse ou un brouillon récent retient le fil).
- **Portée « tous les dossiers »** : un fil éligible part de chaque dossier nettoyable où il a une ligne ; portée « dossier courant » : seulement ce dossier.
- **Départ par le chemin existant** : job `mail:move` op `trash` avec un nouveau champ `cleanupRuleId`, revérifié sous lock dans la transaction de `moveMail`, garde `FETCH FLAGS \Flagged` avant le MOVE comme pour `expiry`.
- **Propriété verrouillée trois fois** : policy RLS de la table (propriétaire de la règle et de l'identité), `insertCleanupRule` qui porte la condition dans l'instruction SQL (utilisable sans RLS par le MCP), et jointure `identities.owner_id = cleanup_rules.owner_id` à chaque tick.
- **Débit borné** : 200 fils par job, un job par (règle, dossier) et par heure tant que le précédent n'est pas terminé (jobId stable), 10 jobs au plus par tick, `priority: 100` pour laisser passer les moves de l'utilisateur.

Écartées :
- Réutiliser `expires_at` (poser une échéance sur chaque fil qui correspond) : `runExpiryTick` la vide hors Archive et une ligne Inbox l'annule, alors que l'Inbox est la cible principale.
- Colonne `cleanup_at` matérialisée par fil : à recalculer à chaque message, chaque move et chaque changement de règle ; l'âge se lit déjà dans `last_activity_at`.
- Règle évaluée à l'arrivée du mail (`rules-processor`) : ne traite ni l'historique ni le vieillissement.
- Matcher SQL seul (`ILIKE`) : ne reproduit pas la recherche que l'utilisateur vient de voir (tokens, `fromDomain`).
- Compte à la création par `initSearch` ou `found` de la recherche affichée : tolérant aux fautes, donc différent de ce que le tick ferait.
- Aperçu calculé par un job du worker : latence derrière la file, alors que web et worker partagent déjà `@common`.

## 2. Contrats gelés (référence de toutes les micro-tâches)

- Outillage : `DC` = `docker compose -f /home/sam/dev/kurrier/compose.tools.yml exec -T node` (lancer `docker compose -f /home/sam/dev/kurrier/compose.tools.yml up -d` une fois avant, `down` à la fin ; jamais `run`, jamais node ni tsx sur le poste). Exception connue de la suite web : `sheet-preview` (xlsx absent en local).
- Table `public.cleanup_rules` : `id uuid pk default gen_random_uuid()`, `owner_id uuid not null -> users(id) on delete cascade`, `identity_id uuid not null -> identities(id) on delete cascade`, `mailbox_id uuid null -> mailboxes(id) on delete cascade` (null = tous les dossiers nettoyables), `query text not null`, `has_attachment boolean not null default false`, `only_unread boolean not null default false`, `retention_days integer not null`, `paused boolean not null default false`, `last_run_at timestamptz`, `last_trashed_at timestamptz`, `trashed_count integer not null default 0`, `created_at`, `updated_at`. Aucun slug, aucun publicId, aucun workspace stocké.
- Contraintes : `retention_days between 1 and 3650` ; `char_length(btrim(query)) between 3 and 200` ; `btrim(query) <> '*'` ; index unique `ux_cleanup_rules_scope (identity_id, coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(query)), has_attachment, only_unread)` ; index `ix_cleanup_rules_identity (identity_id)`.
- RLS activée, policies `TO "kurrier"` au format de `/home/sam/dev/kurrier/db/init/migrations/ss2i_002_migration.sql` (`nullif(current_setting('request.jwt.claim.sub', true), '')::uuid`) : SELECT et DELETE `owner_id = sub` ; INSERT et UPDATE `WITH CHECK (owner_id = sub AND exists (select 1 from identities i where i.id = identity_id and i.owner_id = sub))`.
- Constantes (`/home/sam/dev/kurrier/packages/common/src/cleanup-rules.ts`) : `CLEANUP_ALLOWED_KINDS = ["inbox","archive","custom"]`, `CLEANUP_PRESETS` = 1 sem. (7), 1 mois (30), 3 mois (91), 6 mois (182), 1 an (365), 2 ans (730), `CLEANUP_MIN_DAYS = 1`, `CLEANUP_MAX_DAYS = 3650`, `CLEANUP_BATCH = 200`, `CLEANUP_MAX_JOBS_PER_TICK = 10`, `CLEANUP_MAX_PAGES = 40`, `CLEANUP_PREVIEW_CAP = 2000`, `CLEANUP_MAX_RULES_PER_IDENTITY = 50`.
- Types : `CleanupScope = { identityId, identityPublicId, workspacePublicId, mailboxIds: string[], query, hasAttachment, onlyUnread, retentionDays }` (toujours construit côté serveur depuis la base) ; `CleanupRuleCtx = CleanupScope & { ruleId, ownerId, paused }` ; `CleanupRow = { threadId, mailboxId, expiresAt: Date | null }`.
- Job : `mail:move` avec `{ threadId, threadIds, mailboxId, op: "trash", moveImap, cleanupRuleId }`, options `{ jobId: "cleanup-<ruleId>-<mailboxId>-<expiryBucket(now)>", attempts: 8, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true, removeOnFail: { age: 604800 }, priority: 100 }`. Tick : job `mail:cleanup-tick`, scheduler `cleanup-tick-scheduler`, toutes les 15 min.
- Éligibilité d'une ligne `mt` (SQL unique, `eligibleCleanupThreads`) : `mt.identity_id = scope.identityId` ; `mt.mailbox_id = any(scope.mailboxIds)` ; `mt.thread_id = any(threadIds)` ; `mt.last_activity_at <= cutoff` ; `not mt.starred` ; `mt.snoozed_until is null or mt.snoozed_until <= now` ; si `onlyUnread` : `mt.unread_count > 0` ; si `hasAttachment` : `mt.has_attachments` ; et `not exists` une ligne soeur `s` (même `thread_id`, même `identity_id`, tout dossier) avec `s.starred or s.last_activity_at > cutoff or s.snoozed_until > now`. Les conditions d'âge et d'étoile sont écrites aussi directement sur `mt` pour être relues après l'attente d'un lock (READ COMMITTED). `order by mt.last_activity_at, mt.thread_id`, `for update of mt` sur option.
- `cutoff = now - retentionDays * 86 400 000 ms`, calculé une fois en JS et passé au filtre Typesense et au SQL.

## 3. Micro-tâches

### MT0 - Contrats gelés : migration, schéma drizzle, types [worker]
- Objectif : créer la table `cleanup_rules`, son miroir drizzle, les types et constantes du paragraphe 2, et déclarer `cleanupRuleId?: string` dans le type `MoveJob` (champ déclaré, pas encore lu).
- Fichiers : `/home/sam/dev/kurrier/db/init/migrations/ss2i_012_migration.sql` (style de `ss2i_011` : commentaire d'en-tête, `SET lock_timeout = '5s'`, idempotent : `IF NOT EXISTS`, `DROP POLICY IF EXISTS` puis `CREATE POLICY`, GRANT au rôle `kurrier` comme `ss2i_002`), `/home/sam/dev/kurrier/packages/db/src/drizzle/schema.ts` (`cleanupRules`, `.enableRLS()`, exporté par `@db`), `/home/sam/dev/kurrier/packages/common/src/cleanup-rules.ts` (types et constantes seulement, exporté par l'index de `@common`), `/home/sam/dev/kurrier/apps/worker/lib/imap/imap-move.ts` (type seulement), `/home/sam/dev/kurrier/apps/worker/test/cleanup-contract.ts`.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker && scripts/test.sh tsc-web'`.
- Acceptation : migration jouée deux fois sans erreur sur la base de test ; le test (rouge avant) prouve que la table refuse `retention_days` 0 et 3651, une requête de 2 caractères, la requête `*`, un doublon de portée ; sous `set local role kurrier` avec `request.jwt.claim.sub` d'un autre utilisateur, INSERT refusé sur l'identité d'autrui et SELECT vide ; suppression de l'identité -> règle supprimée.
- Point à lever par le worker : comment `postgres-test` reçoit une nouvelle migration (à l'init seulement ou par `scripts/test.sh`) ; si à l'init seulement, l'appliquer par `psql` dans le service de la base et l'écrire dans le compte rendu. Vérifier aussi que le nouveau test est bien pris par `scripts/test.sh` et par `Dockerfile.web`.
- Levé (MT0) : `postgres-test` est en tmpfs et le service `migrate-test` de `compose.tools.yml` rejoue `db/init/db-bootstrap.sh` sur `db/init/migrations` à chaque `up` (les fichiers déjà enregistrés dans `public.migrations` sont sautés), donc une nouvelle `ss2i_NNN` est prise par `up -d` après `down`, ou par `docker compose -f compose.tools.yml up migrate-test` sur une base déjà lancée, sans `psql` à la main ; `scripts/test.sh worker` prend tout `apps/worker/test/*.ts` (sauf `*-env.ts` et `mcp-fixtures.ts`), `Dockerfile.web` ne boucle que sur `apps/web/test/*.ts` sans base, donc les tests de base du worker n'y passent pas. Précondition : `compose.tools.yml` et `scripts/` (commit be3da290 de `ss2i/ss2i`) manquent à la branche locale, dont l'historique a divergé de `ss2i/ss2i` : ils ont été posés non suivis dans le dépôt (non commités par MT0), à réconcilier par la session principale.
- Dépendances : aucune. Taille : ~180 lignes.

### MT1 - Requête stricte : validation et paramètres Typesense [worker]
- Objectif : fonctions pures `cleanupQueryError(q)`, `cleanupCutoff(now, days)`, `cleanupDaysFromFree(n, unit)` et `cleanupSearchParams(scope, { cutoff, page })`.
- Fichiers : `/home/sam/dev/kurrier/packages/common/src/cleanup-rules.ts`, `/home/sam/dev/kurrier/apps/web/test/cleanup-rules.ts` (import relatif comme `/home/sam/dev/kurrier/apps/web/test/thread-expiry.ts`).
- Spécification : `cleanupQueryError` rend un message si la requête, une fois `trim`, fait moins de 3 ou plus de 200 caractères, vaut `*`, ou n'a aucun token positif (ne commençant pas par `-`) contenant au moins 3 lettres ou chiffres consécutifs (`/[\p{L}\p{N}]{3,}/u`) ; sinon `null`. `cleanupSearchParams` rend `{ q, query_by: "subject,snippet,fromName,fromEmail,fromDomain,participants", filter_by, num_typos: 0, prefix: false, drop_tokens_threshold: 0, typo_tokens_threshold: 0, split_join_tokens: "off", exhaustive_search: true, sort_by: "createdAt:asc", group_by: "threadId", group_limit: 1, per_page: 250, page, include_fields: "id,threadId,mailboxId" }` ; `filter_by` = `workspacePublicId` et `identityPublicId` (via `JSON.stringify`, comme `/home/sam/dev/kurrier/apps/web/lib/search-scope.ts`), `mailboxId:=[...]` (chaque valeur validée par regex UUID, sinon `null` ; liste vide -> `null`), `createdAt:<=<cutoff>` si `cutoff` fourni, `hasAttachment:=1`, `unread:=1` selon le scope. `cleanupDaysFromFree` : jour 1, semaine 7, mois 30, an 365, borné à 1..3650.
- Points à lever par le worker : unité de `createdAt` dans l'index (secondes ou millisecondes : lire `toSearchDoc` dans `/home/sam/dev/kurrier/apps/worker/lib/search/search-common.ts`) et présence de `createdAt` dans `/home/sam/dev/kurrier/packages/schema/src/types/search.ts`. N'ajouter aucun champ à l'index (réindexation de la prod).
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test rouge avant ; refusés : `""`, `"ab"`, `"*"`, `"-banque"`, `"- - -"`, `"a b c"` ; acceptés : `"relevé de compte"`, `"news@liste.org"`, `"tdsynnex.com -promo"` ; les six paramètres stricts sont présents à la valeur exacte ; un test lit le source de `/home/sam/dev/kurrier/apps/web/lib/actions/mailbox.ts` et vérifie que `query_by` y est identique.
- Dépendances : MT0. Taille : ~170 lignes.

### MT2 - Propriété : lecture d'une règle et création sans RLS [lead]
- Objectif : `resolveCleanupScope(dbh, { ownerId, identityId, mailboxId })`, `loadCleanupRule(dbh, ruleId)` et `insertCleanupRule(dbh, { ownerId, identityId, mailboxId, query, hasAttachment, onlyUnread, retentionDays })`.
- Fichiers : `/home/sam/dev/kurrier/packages/common/src/cleanup-store.ts` (exporté par `@common`, `dbh = { execute }` comme `/home/sam/dev/kurrier/apps/worker/lib/mail-expiry.ts`), `/home/sam/dev/kurrier/apps/worker/test/cleanup-owner.ts`.
- Spécification : `loadCleanupRule` joint `identities i on i.id = r.identity_id and i.owner_id = r.owner_id` puis `workspaces`, relit `identityPublicId` et `workspacePublicId`, et calcule `mailboxIds` = dossiers de l'identité dont `kind` est dans `CLEANUP_ALLOWED_KINDS`, restreints à `r.mailbox_id` s'il est posé ; rend `null` si la règle n'existe pas ou si l'identité n'appartient plus à son auteur. `resolveCleanupScope` fait la même chose avant création à partir de `(ownerId, identityId, mailboxId)` et rend `null` si l'identité n'est pas à `ownerId` ou si le dossier demandé n'est pas nettoyable. `insertCleanupRule` : `insert ... select ... from identities i where i.id = $identityId and i.owner_id = $ownerId` (zéro ligne si non propriétaire), dossier vérifié dans la même instruction (même identité, `kind` autorisé), `cleanupQueryError` avant, plafond `CLEANUP_MAX_RULES_PER_IDENTITY`, `on conflict` sur la portée -> `retention_days` mis à jour et `paused = false` ; rend la règle ou une erreur typée.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant, fixtures de `/home/sam/dev/kurrier/apps/worker/test/mcp-fixtures.ts` ; un collègue membre d'une identité partagée ou de domaine ne crée rien (zéro ligne) ; dossier d'une autre identité, Envoyés, Corbeille, Spam, Brouillons refusés ; règle dont l'identité change de propriétaire -> `loadCleanupRule` rend `null` ; doublon -> une seule ligne, durée mise à jour ; `mailboxIds` ne contient jamais un dossier hors allow-list.
- Dépendances : MT0, MT1. Taille : ~200 lignes.

### MT3 - Éligibilité : âge du fil, étoile, snooze, lock [lead]
- Objectif : `eligibleCleanupThreads(dbh, scope, { now, threadIds, mailboxId?, forUpdate? }): Promise<CleanupRow[]>` selon la définition SQL du paragraphe 2.
- Fichiers : `/home/sam/dev/kurrier/packages/common/src/cleanup-eligible.ts` (exporté par `@common`), `/home/sam/dev/kurrier/apps/worker/test/cleanup-eligible.ts`.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant, sur base de test, calqué sur `/home/sam/dev/kurrier/apps/worker/test/expire-tick.ts` ; cas couverts : fil ancien en Inbox -> éligible ; même fil avec un message récent dans le même dossier -> non ; ligne soeur récente en Envoyés ou en Brouillons -> non ; étoile sur la ligne ou sur une soeur -> non ; snooze futur -> non ; `onlyUnread` avec fil lu -> non ; portée « tous les dossiers » : lignes Inbox et Archive rendues toutes les deux ; dossier hors `scope.mailboxIds` jamais rendu ; fil d'une autre identité jamais rendu ; `threadIds` vide -> `[]` sans requête ; `forUpdate` dans une transaction concurrente : une étoile posée pendant l'attente du lock exclut le fil.
- À lever par le lead : origine de `last_activity_at` (`upsertMailboxThreadItem` dans `@common`) ; si c'est l'en-tête `Date` brut, l'écrire dans le compte rendu sans inventer de garde (voir risques).
- Dépendances : MT0. Taille : ~200 lignes.

### MT4 - Matcher commun : candidats Typesense puis SQL [worker]
- Objectif : `matchCleanup({ search, dbh }, scope, { now, limit, maxPages }): Promise<{ rows: CleanupRow[]; truncated: boolean }>` et `countStrictMatches({ search }, scope): Promise<number>`.
- Fichiers : `/home/sam/dev/kurrier/packages/common/src/cleanup-match.ts` (exporté par `@common`), `/home/sam/dev/kurrier/apps/worker/test/cleanup-match.ts`.
- Spécification : `search` est une fonction injectée `(params) => Promise<any>` (aucun client Typesense importé ici). Si `cleanupQueryError(scope.query)` ou si `scope.mailboxIds` est vide : `{ rows: [], truncated: false }` sans appel. Boucle sur les pages de `cleanupSearchParams(scope, { cutoff, page })` : `threadId` de chaque `grouped_hits`, puis `eligibleCleanupThreads(dbh, scope, { now, threadIds })` ; arrêt quand le nombre de fils distincts atteint `limit` (`truncated: true`), quand une page rend moins de 250 groupes, ou à `maxPages` (`truncated: true`). `countStrictMatches` : une recherche page 1 sans `cutoff`, `per_page: 1`, rend `found`.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant, faux `search` qui sert des pages depuis des fixtures en base ; un candidat rendu par l'index mais inéligible en SQL (étoilé, déplacé en Corbeille, fil actif) n'est jamais dans `rows` ; des pages entières de candidats inéligibles n'empêchent pas d'atteindre les éligibles des pages suivantes ; `limit` respectée ; `maxPages` respectée ; requête invalide -> zéro appel à `search`.
- Dépendances : MT1, MT3. Taille : ~160 lignes.

### MT5 - `moveMail` : job de nettoyage revérifié sous lock [lead]
- Objectif : faire lire `cleanupRuleId` à `moveMail`, avec les mêmes gardes que `expiry`.
- Fichiers : `/home/sam/dev/kurrier/apps/worker/lib/imap/imap-move.ts`, `/home/sam/dev/kurrier/apps/worker/test/cleanup-move.ts`.
- Spécification : au début, si `cleanupRuleId` : sortir sans rien faire si `op !== "trash"`, si `loadCleanupRule` rend `null`, si la règle est en pause ou si `fromMailboxId` n'est pas dans `ctx.mailboxIds` ; `ids` réduit par `eligibleCleanupThreads(db, ctx, { now, threadIds: ids, mailboxId: fromMailboxId })` ; `messageIds` ignoré (fil entier, comme `expiry`). Dans la transaction, après l'update des messages (même ordre de locks que l'étoile web) : `select 1 from cleanup_rules where id = ... and not paused for share`, puis `eligibleCleanupThreads(tx, ..., forUpdate: true)` ; règle absente ou nombre de fils différent -> `ExpiryChanged` (nouvel essai, 3 au plus, comportement existant). `srcExpiry` reçoit l'`expires_at` courant des lignes Archive pour que `resettleThread` le remette si le serveur refuse le MOVE. La garde `FETCH FLAGS \Flagged` s'applique aussi (`ctx.expiry || cleanup`). Après le move : `update cleanup_rules set trashed_count = trashed_count + n, last_trashed_at = now()` avec `n` = fils réellement partis. Le chemin `expiry` existant ne change pas d'un caractère de comportement.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant (move en base, `moveImap: false`) ; fil ancien en Inbox -> ligne en Corbeille, `expires_at` nul à l'arrivée, compteur de la règle incrémenté ; règle supprimée ou mise en pause entre le tick et le job -> rien ne bouge ; fil étoilé ou réactivé après le tick -> reste, les autres partent ; job avec `cleanupRuleId` et `op: "archive"` -> rien ; dossier source hors portée de la règle -> rien ; fil déjà présent en Corbeille (clash) -> fusion sans erreur ; `/home/sam/dev/kurrier/apps/worker/test/expire-tick.ts` et les tests de move existants restent verts ; câblage de la garde `\Flagged` vérifié dans le source.
- Dépendances : MT2, MT3. Taille : ~200 lignes.

### MT6 - Tick `runCleanupTick` [lead]
- Objectif : `runCleanupTick({ now, enqueue, search })` qui poste les jobs du paragraphe 2.
- Fichiers : `/home/sam/dev/kurrier/apps/worker/lib/mail-cleanup.ts`, `/home/sam/dev/kurrier/apps/worker/test/cleanup-tick.ts`.
- Spécification : règles `not paused` triées `last_run_at nulls first, id` ; pour chacune `loadCleanupRule` (rien d'autre que `ruleId` ne vient de la ligne sans jointure de propriété), `matchCleanup` avec `limit: CLEANUP_BATCH` et `maxPages: CLEANUP_MAX_PAGES`, regroupement par `mailboxId`, un `enqueue("mail:move", ...)` par dossier (`moveImap` = présence d'une ligne `mailbox_sync`, comme `runExpiryTick`), puis `last_run_at = now`. Arrêt à `CLEANUP_MAX_JOBS_PER_TICK` jobs : les règles non traitées passent en tête au tick suivant. Le tick n'écrit rien d'autre que `last_run_at` ; une erreur sur une règle (Typesense indisponible) est journalisée et n'arrête pas les autres. Rend `{ rules, jobs }`.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant, `enqueue` et `search` factices ; jobId stable dans l'heure et identique à deux ticks successifs ; données du job : `op: "trash"`, `cleanupRuleId`, 200 fils au plus, aucun slug ni publicId ; règle en pause, règle orpheline (identité transférée), requête invalide -> aucun job ; 12 règles avec des fils dus -> 10 jobs au premier tick, les 2 restantes au suivant ; fil visé par deux règles -> deux jobs, sans erreur ; `mailbox_threads` strictement inchangé après le tick (aucun `expires_at` écrit).
- Dépendances : MT4, MT5. Taille : ~170 lignes.

### MT7 - Branchement du tick dans le common-worker [worker]
- Objectif : case `mail:cleanup-tick` et scheduler `cleanup-tick-scheduler` (15 min), à côté de `mail:expire-tick`.
- Fichiers : `/home/sam/dev/kurrier/apps/worker/server/plugins/common-worker.ts`, `/home/sam/dev/kurrier/apps/worker/test/cleanup-wiring.ts`.
- Spécification : `enqueue` = `smtpQueue.add`, `search` = `(p) => client.collections("messages").documents().search(p)` avec le client de `/home/sam/dev/kurrier/apps/worker/lib/get-typesense` ; options du scheduler copiées de `expire-tick-scheduler`.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test de câblage sur le source (rouge avant) : le case existe, appelle `runCleanupTick`, le scheduler existe avec `every: 15 * 60 * 1000` et `attempts: 1` ; `mail:expire-tick` inchangé.
- Dépendances : MT6. Taille : ~60 lignes.

### MT8 - Actions serveur du web [worker]
- Objectif : `previewCleanupRule`, `createCleanupRule`, `listCleanupRules`, `setCleanupRulePaused`, `deleteCleanupRule`.
- Fichiers : `/home/sam/dev/kurrier/apps/web/lib/actions/cleanup-rules.ts` (nouveau, `"use server"`), `/home/sam/dev/kurrier/apps/web/test/cleanup-actions.ts`.
- Spécification : entrée de preview et de création = `{ identityPublicId, mailboxSlug, allFolders, query, hasAttachment, onlyUnread, retentionDays }`. Toujours : `assertSignedIn`, `assertIdentityAccess({ publicId })`, puis `identity.ownerId !== user.id` -> erreur « Une règle de nettoyage ne se crée que sur vos propres boîtes » (même garde que `addWebhook` dans `/home/sam/dev/kurrier/apps/web/lib/actions/dashboard.ts`) ; dossier relu par RLS depuis `(identity.id, mailboxSlug)` ; scope par `resolveCleanupScope`, jamais depuis les chaînes du client. Preview : `{ matching: countStrictMatches, dueNow, truncated }` avec `matchCleanup(limit: CLEANUP_PREVIEW_CAP)` et le nombre de fils distincts. Création : `insertCleanupRule` dans la transaction `rlsClient` (la policy s'applique en plus). Liste, pause, suppression : sous RLS, filtrées par identité ; la liste rend le nom du dossier ou « Tous les dossiers », la durée, `trashedCount`, `lastTrashedAt`, `paused`. Client Typesense construit comme dans `/home/sam/dev/kurrier/apps/web/lib/actions/select-all.ts`. La création ne poste aucun job : le tick suivant s'en charge.
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test rouge avant, sur le modèle de `/home/sam/dev/kurrier/apps/web/test/webhook-owner.ts` ; garde de propriété présente avant tout accès aux données dans preview et création ; aucun `workspacePublicId` ni identifiant de dossier du client ne parvient au matcher ; preview et tick appellent la même fonction `matchCleanup` (vérifié dans les deux sources) ; `starred` n'est pas un paramètre.
- Dépendances : MT2, MT4. Taille : ~200 lignes.

### MT9 - Réglages : liste des règles, pause, suppression, dans les deux interfaces [worker]
- Objectif : page « Nettoyage automatique » des réglages de l'identité, atteignable depuis la navigation classique et la navigation k.
- Fichiers : `/home/sam/dev/kurrier/apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/cleanup/page.tsx`, `/home/sam/dev/kurrier/apps/web/components/mailbox/settings/cleanup-rules-list.tsx`, `/home/sam/dev/kurrier/apps/web/components/k/settings-shell.tsx`, `/home/sam/dev/kurrier/apps/web/components/mailbox/settings/settings-tabs.tsx`, `/home/sam/dev/kurrier/apps/web/test/cleanup-settings.ts`.
- Spécification : modèle = `/home/sam/dev/kurrier/apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/blocked/page.tsx` et `/home/sam/dev/kurrier/apps/web/components/mailbox/settings/blocked-senders-list.tsx`. Une ligne par règle : texte cherché, portée, filtres, « au-delà de <durée> », « N fils nettoyés, dernier le <date> » (dates en 24 h), bouton Suspendre ou Reprendre, bouton Supprimer avec confirmation ; l'état de chaque action est visible (en cours, fait, erreur). Liste vide : une phrase qui dit que les règles se créent depuis une recherche. Identité dont on n'est pas propriétaire : page en lecture d'un message, sans liste.
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test de câblage rouge avant : entrée de navigation présente dans les deux fichiers de navigation et pointant sur `/settings/cleanup` ; la page appelle `listCleanupRules`, le composant `setCleanupRulePaused` et `deleteCleanupRule`.
- Dépendances : MT8. Taille : ~200 lignes.

### MT10 - Formulaire « Nettoyage auto... » partagé [worker]
- Objectif : composant `KCleanupRule` (durée, aperçu, confirmation, création), utilisé par les deux interfaces comme `KArchiveFor`.
- Fichiers : `/home/sam/dev/kurrier/apps/web/components/k/cleanup-rule-form.tsx`, `/home/sam/dev/kurrier/apps/web/test/cleanup-form.ts`.
- Spécification : props `{ identityPublicId, mailboxSlug, mailboxName, allFolders, query, hasAttachment, onlyUnread, onDone }`. Présets de `CLEANUP_PRESETS` plus saisie libre (nombre et unité jour, semaine, mois, an, convertie par `cleanupDaysFromFree`), présentation reprise de `/home/sam/dev/kurrier/apps/web/components/k/archive-for.tsx`. Au choix d'une durée : `previewCleanupRule`, puis récapitulatif : texte cherché, portée, filtres, « X fils correspondent exactement (sans tolérance aux fautes de frappe), N partent à la Corbeille dans le quart d'heure » (`2 000+` si tronqué), « ensuite, chaque fil sans nouveau message depuis <durée> », « les fils étoilés restent », « la Corbeille se vide au bout de 30 jours ». Bouton « Créer la règle » seulement après l'aperçu ; erreur de `cleanupQueryError` affichée telle quelle ; après création, lien vers la page de MT9.
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test rouge avant (logique pure extraite et câblage dans le source) : création impossible sans aperçu réussi ; les six présets valent 7, 30, 91, 182, 365, 730 jours ; saisie libre bornée à 1..3650 jours.
- Dépendances : MT1, MT8. Taille : ~200 lignes.

### MT11 - Recherche de l'interface classique : bouton et note Nouveautés [worker]
- Objectif : bouton « Nettoyage auto... » dans la recherche classique, ouvrant `KCleanupRule` avec la recherche telle qu'à l'écran.
- Fichiers : `/home/sam/dev/kurrier/apps/web/components/mailbox/default/mailbox-search.tsx`, au besoin `/home/sam/dev/kurrier/apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]/search/page.tsx`, `/home/sam/dev/kurrier/apps/web/changelogs/2026-11-25.md` (date du jour du commit, suffixe `-N` si le fichier existe), `/home/sam/dev/kurrier/apps/web/test/cleanup-search-classic.ts`.
- Spécification : bouton visible quand la requête n'est pas vide et que l'utilisateur est propriétaire de l'identité ; désactivé avec une explication quand le filtre « étoilé » est actif (un fil étoilé n'est jamais nettoyé) et quand le dossier courant n'est pas nettoyable hors mode « tous les dossiers ». Transmet `query`, `allFolders`, `hasAttachment`, `onlyUnread`, dossier courant. La note Nouveautés décrit la création depuis une recherche et la page des réglages.
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test de câblage rouge avant ; note présente ; le bouton ne transmet jamais `starred`.
- Dépendances : MT7, MT9, MT10 (aucune règle ne doit pouvoir être créée avant que le tick tourne et que la liste existe). Taille : ~150 lignes.

### MT12 - Recherche de l'interface k : bouton [worker]
- Objectif : même bouton dans la nouvelle interface.
- Fichiers : `/home/sam/dev/kurrier/apps/web/components/k/search-header.tsx`, au besoin `/home/sam/dev/kurrier/apps/web/components/k/thread-list.tsx`, `/home/sam/dev/kurrier/apps/web/test/cleanup-search-k.ts`.
- Spécification : mêmes règles de visibilité que MT11, attribut `data-k-action="cleanup-rule"` sur le bouton ; ne touche pas à la note Nouveautés.
- Vérification : `DC sh -c 'scripts/test.sh web && scripts/test.sh tsc-web'`.
- Acceptation : test de câblage rouge avant ; mêmes props transmises que dans MT11.
- Dépendances : MT7, MT9, MT10. Taille : ~120 lignes.

### MT13 - Outils MCP (optionnel, en dernier) [worker]
- Objectif : outils `list_cleanup_rules`, `create_cleanup_rule`, `pause_cleanup_rule`, `delete_cleanup_rule`.
- Fichiers : `/home/sam/dev/kurrier/apps/worker/lib/mcp/tools.ts`, `/home/sam/dev/kurrier/apps/worker/test/mcp-cleanup.ts`.
- Spécification : `create_cleanup_rule` (`identity`, `query`, `folder` optionnel, `has_attachment`, `only_unread`, `keep_days`, `confirm`) : sans `confirm: true`, rend seulement l'aperçu (`matching`, `due_now`) ; avec, crée par `insertCleanupRule` avec l'`ownerId` de la session MCP et une identité du workspace de la clé (helpers de `/home/sam/dev/kurrier/apps/worker/lib/mcp/access.ts`). Liste, pause et suppression filtrées par `owner_id`. Description : rien n'est supprimé définitivement, confirmer avec l'utilisateur avant de créer.
- Vérification : `DC sh -c 'scripts/test.sh worker && scripts/test.sh tsc-worker'`.
- Acceptation : test rouge avant sur le modèle de `/home/sam/dev/kurrier/apps/worker/test/mcp-isolation.ts` : un utilisateur ne liste, ne suspend ni ne supprime la règle d'un autre ; création refusée sur l'identité d'un autre et sur une identité partagée ; sans `confirm`, aucune ligne créée ; `mcp-isolation` et `mcp-clients` restent verts.
- Dépendances : MT2, MT4. Taille : ~200 lignes.

## 4. Noyau délicat (pourquoi quatre micro-tâches partent chez lead)

- MT2 (sécurité) : le worker et le MCP tournent sans RLS. Une règle est une suppression permanente et répétée : la condition de propriété doit être dans l'instruction SQL elle-même et à chaque lecture, sinon un collègue membre d'une boîte partagée purge la boîte d'un autre (même famille que GHSA-cvh9-93mg-xvc9, commit 29091854).
- MT3 (calcul délicat, concurrence) : l'âge du fil se lit sur plusieurs lignes, la relecture sous lock ne revoit que la ligne verrouillée (les soeurs gardent le snapshot de l'instruction) ; les conditions doivent être écrites sur `mt` et sur les soeurs, et le test de concurrence doit le prouver.
- MT5 (concurrence, régression) : `moveMail` est le chemin de tous les déplacements ; l'ordre des locks, `ExpiryChanged`, `resettleThread` et la garde `\Flagged` existent pour `expiry` et ne doivent pas bouger.
- MT6 (idempotence, débit) : jobId, plafonds et ordre de passage décident de ce qui arrive lors d'une reprise après panne et de la première exécution sur deux ans de courrier.
- Tout le reste est du câblage sur contrat gelé : worker.

## 5. Risques et pièges

- Requête qui attrape tout (`*`, exclusions seules, token d'une lettre) : refusée par `cleanupQueryError`, par la contrainte de table et de nouveau par le matcher à chaque tick.
- Index Typesense en retard ou incohérent : il ne fournit que des candidats ; un fil absent de l'index attend le tick suivant, un candidat périmé est rejeté par le SQL.
- Candidats inéligibles en tête de liste (tri `createdAt:asc`) qui affament les éligibles : pagination jusqu'à 40 pages par règle et par tick (10 000 candidats) ; au-delà, journal d'avertissement. À surveiller en prod sur les premières règles.
- Première exécution volumineuse : 200 fils par (règle, dossier) et par tick, soit 800 fils par heure ; 10 jobs par tick au plus ; `priority: 100`. À confirmer par le lead de MT6 : l'option `priority` de la version de BullMQ installée fait bien passer les jobs sans priorité avant ; sinon la retirer et garder les plafonds.
- En-tête `Date` ancien sur un mail qui vient d'arriver : si `last_activity_at` vient de cet en-tête, le mail part au tick suivant. Filet : Corbeille 30 jours. Si MT3 confirme cette origine, décision à remonter à Samuel (délai de grâce après l'arrivée), pas de garde inventée en cours de route.
- Message qui arrive dans un autre dossier du fil pendant le job : l'ancien morceau peut partir alors que le fil vient de reprendre (limite identique à celle de `inboxSister` aujourd'hui) ; il reste 30 jours en Corbeille et le nouveau message reste en place.
- Compte affiché plus petit que la liste de la recherche (recherche tolérante, règle stricte) : le formulaire l'écrit en toutes lettres.
- Règle supprimée ou suspendue pendant qu'un job attend : `moveMail` relit la règle au début et la verrouille (`for share`) dans la transaction.
- Fil archivé avec durée de vie et visé par une règle : le premier des deux le déplace, l'autre ne trouve plus rien ; l'`expires_at` est remis si le serveur refuse le MOVE.
- Déploiement : `ss2i_012` doit être copiée dans les migrations de la stack et appliquée avant le redémarrage du worker (le tick lit la table dès son premier passage). Aucun changement de schéma Typesense, donc aucune réindexation. Outil interne : déploiement sans créneau.
- Non vérifié par une recherche contradictoire (pas d'accès web dans cette session) : comportement de `split_join_tokens: "off"` et de la correspondance entre champs sur Typesense 29 ; couvert par le contrôle réel ci-dessous.
- Information manquante : le mode d'application d'une nouvelle migration sur `postgres-test` (levée par MT0).

## 6. Critères de vérification du chantier (après la dernière micro-tâche)

- Suites complètes : `DC sh -c 'scripts/test.sh worker && scripts/test.sh web && scripts/test.sh tsc-worker && scripts/test.sh tsc-web'`, vertes sauf `sheet-preview`.
- Typesense réel (dev ou prod) : une requête avec une faute de frappe, puis un préfixe seul, donnent un aperçu à 0 alors que la recherche affichée trouve des fils.
- Chrome, interface classique puis interface k : recherche dans l'Inbox -> « Nettoyage auto... » -> 1 semaine -> aperçu -> création -> la règle apparaît dans les réglages -> dans le quart d'heure les fils anciens sont en Corbeille, un fil étoilé et un fil avec un message récent restent -> suspendre, reprendre, supprimer.
- Compte d'un collègue membre d'une boîte partagée : pas de bouton, action refusée si elle est appelée à la main.
- En base après un tick : aucun `expires_at` écrit par le nettoyage, `trashed_count` égal au nombre de fils partis ; `mail:expire-tick` continue de tourner comme avant (journal du common-worker).
- `git log` de chaque commit sans mention d'IA.

## 7. Parallélisation (fichiers disjoints)

- MT4 et MT5 ensemble, après MT3.
- MT8 en parallèle de MT5, MT6 et MT7, après MT4.
- MT9 et MT10 ensemble, après MT8.
- MT11 et MT12 ensemble, après MT7, MT9 et MT10 (seule MT11 touche la note Nouveautés).
- MT13 en parallèle de MT9 à MT12, après MT4.
- Strictement en série : MT0 -> MT1 -> MT2 -> MT3, puis MT5 -> MT6 -> MT7.

## 8. État

- [ ] MT0 contrats gelés [worker] - commit :
- [ ] MT1 requête stricte [worker] - commit :
- [ ] MT2 propriété [lead] - commit :
- [ ] MT3 éligibilité [lead] - commit :
- [ ] MT4 matcher commun [worker] - commit :
- [ ] MT5 moveMail [lead] - commit :
- [ ] MT6 tick [lead] - commit :
- [ ] MT7 branchement common-worker [worker] - commit :
- [ ] MT8 actions web [worker] - commit :
- [ ] MT9 réglages, deux interfaces [worker] - commit :
- [ ] MT10 formulaire partagé [worker] - commit :
- [ ] MT11 recherche classique et note Nouveautés [worker] - commit :
- [ ] MT12 recherche k [worker] - commit :
- [ ] MT13 outils MCP, optionnel [worker] - commit :
- [ ] Revue critic du diff complet contre ce plan - verdict :
