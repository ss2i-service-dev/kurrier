# Nitro starter

Look at the [nitro quick start](https://nitro.build/guide#quick-start) to learn more how to get started.

## Maintenance ponctuelle (ss2i)

Rattrapage des abonnements (`mail_subscriptions`) sur les messages deja en base : demarrer le worker avec `KURRIER_BACKFILL_SUBSCRIPTIONS=1` (plugin `server/plugins/ss2i-maintenance.ts`). Idempotent et non destructif (jamais d'ecrasement d'un statut `unsubscribed`) ; la progression est dans le journal du worker (`[backfill-subscriptions]`). Retirer la variable ensuite.
