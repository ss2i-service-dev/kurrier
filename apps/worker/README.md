# Nitro starter

Look at the [nitro quick start](https://nitro.build/guide#quick-start) to learn more how to get started.

## One-off maintenance

To rebuild the subscriptions (`mail_subscriptions`) from messages already in the database, start the worker with `KURRIER_BACKFILL_SUBSCRIPTIONS=1` (see `server/plugins/maintenance.ts`). The run is idempotent and non-destructive (an `unsubscribed` status is never overwritten), and progress is logged with the `[backfill-subscriptions]` prefix. Unset the variable afterwards.
