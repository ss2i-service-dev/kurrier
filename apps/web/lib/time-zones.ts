import { getTimeZones } from "@vvo/tzdb";

// getTimeZones() recomputes the offsets of the ~400 zones on every call (~80 ms). Called for
// every row of the list (Snooze button), it cost seconds of server CPU when rendering a
// mailbox of 50 threads. The table does not change during the life of the process.
let cached: ReturnType<typeof getTimeZones> | undefined;
export const cachedTimeZones = () => (cached ??= getTimeZones());
