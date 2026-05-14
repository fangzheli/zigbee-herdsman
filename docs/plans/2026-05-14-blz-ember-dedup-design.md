# BLZ Ember/EZSP Dedup Experiment

## Goal

Create an experimental branch that makes the BLZ adapter look less like a copied
legacy EZSP adapter while preserving BLZ-specific protocol behavior. The branch
should also document what the current `ember` adapter does better than legacy
`ezsp`, and it should avoid lifecycle or timer changes that can leak memory.

## Current Shape

There are three relevant implementations:

- `src/adapter/ezsp`: legacy Silicon Labs EZSP adapter. It is still available,
  but its startup warning says it is deprecated and recommends migration to
  `ember` for newer firmware.
- `src/adapter/ember`: current Silicon Labs adapter. It uses the newer typed
  EZSP/ASH implementation and richer adapter behavior.
- `src/adapter/blz`: Bouffalo BLZ adapter. It is not EZSP on the wire, but much
  of its adapter/driver layout was copied from legacy `ezsp`.

The first low-risk duplication is adapter-level ZCL waiter matching. BLZ had its
own `WaitressMatcher`, timeout formatter, and validator. That duplicated logic
already existed centrally on `Adapter` and in the legacy EZSP adapter.

## Refactor Direction

Recommended approach: incremental convergence.

1. Reuse common adapter-layer primitives first.
   - Use `Adapter.zclWaitressValidator` and
     `Adapter.clusterWaitressTimeoutFormatter` in BLZ.
   - Keep BLZ-specific frame construction, channel-change handling, join/leave
     semantics, and unsupported feature decisions local to BLZ.

2. Extract only proven protocol-neutral helpers.
   - Candidate helpers: bounded delimited parser behavior, CRC16, byte stuffing,
     request timeout cleanup, listener/timer teardown assertions.
   - Do not merge BLZ's transport into EZSP/ASH. BLZ has a different frame
     header, command IDs, reset behavior, and acknowledgement model.

3. Use the `ember` adapter as the target architecture, not as a direct base
   class.
   - Adopt typed event maps where practical.
   - Prefer one owner for request waiters and lifecycle cleanup.
   - Cache network parameters instead of repeatedly asking the NCP.
   - Keep queue and waiters explicit so timeout cancellation remains visible.

Rejected approach: making BLZ inherit from legacy `EZSPAdapter`.

- It would reduce surface duplication quickly, but it would encode the wrong
  protocol identity and keep the deprecated architecture as the parent.

Rejected approach: port BLZ directly onto `EmberAdapter`.

- `EmberAdapter` assumes Silicon Labs EZSP commands, ASH framing, stack status
  callbacks, and Ember-specific policies. BLZ can borrow patterns from it, but a
  direct subclass would be fragile.

## Ember Advantages Over Legacy EZSP

The current `ember` path has several advantages that are useful as a model for
BLZ:

- It is the migration target for Silicon Labs firmware newer than the legacy
  EZSP path. Discovery tests also treat mDNS `ezsp` radio type as `ember`.
- It has a richer stack configuration surface: concentrator settings, child
  limits, transient key timeout, poll timeout, and optional CCA mode.
- It explicitly manages source route discovery and multicast table entries.
- It has a network cache for EUI64, PAN ID, extended PAN ID, channel, and update
  ID to avoid frequent NCP transactions.
- It uses a typed EZSP event map and a single adapter-level `EmberOneWaitress`
  for cross-event matching between incoming messages and message-sent callbacks.
- Its ASH layer uses bounded/preallocated buffers and free lists, reducing
  allocation churn and making overflow handling explicit.
- Its stop path clears watchdog intervals and removes EZSP/ASH/port listeners.

## Memory Leak Guardrails

Future BLZ refactors should follow these rules:

- Any `setInterval` or `setTimeout` added for watchdogs, retries, or deferred
  channel-change work must be cleared in `stop()` or `close()`.
- Any listener added during startup must either be registered on an object that
  is discarded on stop, or be removed explicitly on stop. Avoid repeatedly
  creating `.bind(this)` handlers on a long-lived object unless `removeAllListeners`
  is called for that object.
- Waiters must be cancelled on send failure and cleared during adapter/driver
  stop.
- Parser tail buffers must stay bounded when delimiters are missing.
- Any extraction should add a regression test for waiter timeout cleanup,
  listener count stability across start/stop, or bounded buffering if it touches
  those areas.

## Completed In This Experiment

- Created branch `experiment/blz-ember-dedup`.
- Changed BLZ adapter ZCL waiter matching to use the shared `Adapter` matcher and
  timeout formatter.
- Added a regression test proving BLZ now resolves a waiter on a ZCL default
  response the same way the shared adapter matcher does.
- Changed `Blz.connect()` to clear an existing watchdog interval before creating
  a replacement interval, with a regression test for repeated reconnects.
- Extracted BLZ ZDO unicast/broadcast transmission into `sendZdoFrame()`.
  The helper now owns logging, driver dispatch, false-send errors, thrown-send
  errors, and waiter cancellation.
- Added a regression test proving a ZDO waiter is cancelled when the lower driver
  send rejects before the waiter is started.
- Changed `BLZAdapter.start()` to reset the `closing` state after a previous
  `stop()`, with a regression test proving a driver close after restart still
  emits `disconnected`.
- Extracted BLZ NWK update channel-change payload normalization and parsing into
  `parseNwkUpdateChannelChange()`. The adapter now uses that pure helper before
  broadcasting the canonical payload through `sendZdoFrame()`.
- Added pure tests for NWK update payload layouts with and without TSN,
  `nwkManagerAddr`, and ZDO overhead, plus non-channel-change, multi-channel
  mask, empty-mask, and invalid-length rejection cases.
- Tightened close-path cleanup for BLZ lifecycle layers:
  `SerialDriver` now removes parser listeners and detaches serial-port and TCP
  socket listeners on failed open and normal close, and `Driver.stop()` clears
  pending waiters in a `finally` block if the lower BLZ close throws.
- Added regression tests for UART failed-open cleanup, UART close listener
  cleanup, TCP socket failed-open/close cleanup, and high-level driver waiter
  timer cleanup when BLZ close rejects.
- Tightened parser tail retention: garbage without a START delimiter is now
  discarded immediately instead of being retained until the overflow guard trips.
  Only an actual partial frame starting at START remains in the bounded tail.
- Extracted BLZ byte stuffing and unstuffing into `framing.ts`, so `Parser` and
  `Writer` now share one delimiter escaping implementation. Added pure helper
  tests for reserved-byte escaping, unescaping, and round trips.
- Centralized BLZ frame CRC append and verification in `framing.ts`, so
  `Writer` and `Frame` use the same CRC byte ordering and mismatch message
  behavior. Added pure tests for non-mutating CRC append and mismatch handling.
- Extracted raw frame construction and delimiter wrapping into `framing.ts`.
  `Writer` no longer expands payload bytes into a temporary number array before
  CRC/stuffing, reducing allocation churn on outgoing frames.
- Reduced BLZ frame stuffing, unstuffing, and delimiter wrapping allocation
  churn by writing into pre-sized buffers instead of building large intermediary
  number arrays.
- Fixed TCP socket open cleanup when the socket reaches `ready` but reset
  fails: the connect promise now rejects and parser/socket listeners, pipes, and
  socket resources are cleaned up through the same failed-open path.
- Centralized high-level APS send argument construction for unicast, multicast,
  and broadcast driver requests. Multicast and broadcast requests now return
  `false` when the lower BLZ `sendApsData` status is non-success instead of
  reporting success after a rejected send status.
- Tightened high-level startup failure cleanup: if `Driver.startup()` creates
  and connects a `Blz` instance but a later initialization step fails, it now
  tears down listeners, waiters, watchdogs, and lower transport resources through
  `stop(false)` while preserving the original startup error.
- Added a reverse node-ID-to-EUI64 cache in the high-level driver. Join,
  `setNode`, ZDO network-address responses, and `networkIdToEUI64` now update
  one shared cache path; leave removes both directions so incoming APS messages
  can carry `senderEui64` without stale entries. Re-caching a node ID with a new
  EUI64 also removes the old EUI64 mapping to avoid stale sends and cache growth.
  Request-time EUI64-to-node resolution now uses the same cache helper so
  subsequent incoming APS messages can include `senderEui64`.
- Cleared address caches after successful `formNetwork()`, preventing stale
  device mappings from surviving a fresh network formation or restore.
- Made `Driver.startup()` close any existing `Blz` instance before replacing it,
  preventing repeated startup from orphaning listeners, waiters, watchdogs, or
  lower transport resources.
- Tightened `Blz.connect()` retry cleanup: each failed connection attempt now
  clears pending queues/waiters and closes the serial driver without removing
  the long-lived BLZ event bridge needed by later retries.
- Centralized the BLZ-to-serial-driver event bridge and made it reattach after a
  full `Blz.close()`, so reusing a `Blz` instance after close does not lose
  `received` or `close` event handling.
- Extended `Driver.stop()` cleanup to clear address caches along with pending
  waiters, avoiding stale device mappings after shutdown even if the lower close
  path throws.
- Reused one BLZ watchdog cleanup path for successful reconnect, failed
  reconnect attempts, and close. A failed reconnect after a previous successful
  connection no longer leaves the old watchdog interval alive.
- Released the UART serial-port reference after a successful serial
  `asyncFlushAndClose()`, matching the TCP close path and avoiding retention of
  a closed port object after shutdown.
- Reset the BLZ watchdog failure counter after a successful heartbeat, so
  intermittent heartbeat misses do not accumulate across healthy checks and
  trigger unnecessary reset/startup cleanup cycles.
- Released the high-level driver's `Blz` instance reference after successful
  `Driver.stop()`, so closed transport/watchdog state is not retained and later
  startup/reset paths do not re-close the same object.
- Restored the adapter `closing` state when `BLZAdapter.stop()` fails, so a
  later lower-driver close still emits `disconnected` instead of being
  suppressed as if shutdown had completed.
- Made the UART send-retry failure regression deterministic with fake timers,
  removing the real three-second retry delay that could intermittently exceed
  the Vitest timeout on loaded runs.
- Coalesced concurrent high-level `Driver.reset()` calls into one reset flow, so
  watchdog and UART-triggered resets cannot overlap and double-run
  stop/startup cleanup against the same BLZ resources.
- Cancelled the startup phase of an in-flight high-level `Driver.reset()` when
  an external `Driver.stop()` interrupts it, preventing shutdown from being
  followed by an unexpected driver restart.
- Marked the UART driver uninitialized on abnormal port close before emitting
  `reset`, so higher layers do not attempt direct UART operations against a
  closed port during recovery.
- Closed an already-initialized serial driver before a successful `Blz.connect()`
  reconnect attempt, preventing reconnects from orphaning the previous serial
  port while replacing watchdog state.
- Cleared the old watchdog, queue, and BLZ waiters before reconnect pre-close,
  so a failure while closing the existing serial driver cannot leave stale
  timers or pending request state alive.
- Made `SerialDriver.close()` detach and release a serial port even after an
  abnormal port close already marked it uninitialized, avoiding retained pipes,
  listeners, and closed port references during reset recovery.
- Hardened the shared `Queue` used by BLZ reset/close paths: a running job that
  was removed by `Queue.clear()` no longer removes or starts unrelated jobs when
  its `finally` block later runs.
- Extended `Queue.clear()` to reject jobs that have not started yet, so BLZ
  reset/close cleanup does not leave queued command promises permanently
  pending after their queue entry is discarded.
- Extended shared `Waitress.clear()` to reject pending waiters, so BLZ
  adapter/driver/UART cleanup resolves callers instead of leaving external
  request promises hanging after reset or stop.
- Removed timed-out waiters from shared `Waitress` as soon as their timeout
  fires, preventing BLZ request waiters from remaining in memory until a later
  unrelated frame happens to scan the waiter map.
- Extended shared `Waitress.remove()` to reject removed waiters, so explicit
  BLZ waiter cancellation does not leave external request promises pending.
- Changed BLZ `sendZclFrameToAll()` to use the broadcast APS path instead of
  the multicast path, matching the method contract and preserving the existing
  post-send settle delay.
- Cleared the BLZ adapter-level command queue during `BLZAdapter.stop()`, so
  commands that have not started yet are rejected instead of staying pending or
  running after shutdown.
- Cleared UART-level waiters during `SerialDriver.reset()`, so an in-flight
  `sendDATA()` does not remain pending across a reset until its normal timeout
  and retry path fires.
- Avoided creating UART waiters for reset frames that intentionally do not wait
  for a response, preventing unstarted waiters with no timer from accumulating.
- Avoided creating BLZ command waiters for `execCommand("reset")`, matching the
  reset command's no-response behavior and preventing high-level unstarted
  waiters from accumulating.
- Defused UART waiter cancellation when `writer.sendData()` throws before the
  waiter is started, preventing `Waitress.remove()` from creating an unhandled
  internal rejection.
- Defused BLZ command waiter cancellation when lower `sendDATA()` rejects before
  the command waiter is started, avoiding the same unhandled internal rejection
  at the command queue layer.
- Defused BLZ adapter ZCL response waiter cancellation when APS send fails before
  the response waiter is started, preventing `Waitress.remove()` from surfacing
  an unhandled internal rejection.
- Defused high-level driver waiter cancellation before `waiter.start()`, so ZDO
  send-failure cleanup can cancel driver waiters without unhandled internal
  rejections.
- Moved unstarted-waiter rejection handling into shared `Waitress`: remove/clear
  still reject the underlying promise, but internally mark unstarted promises as
  handled so cleanup before `start()` cannot create unhandled rejections.
- Removed the now-duplicated unstarted-waiter catch logic from BLZ UART, command,
  driver, and adapter waiter wrappers so cancellation semantics live in the
  shared `Waitress` implementation.
- Made BLZ group and broadcast ZCL sends check the lower multicast/broadcast
  request status and reject on false-send results instead of reporting success.
- Aligned BLZ ZCL endpoint/group/broadcast sends with the common adapter
  interface by honoring optional `profileId`, honoring group `sourceEndpoint`,
  and using endpoint `0xff` for group APS frames.
- Centralized BLZ ZCL APS frame construction for endpoint, group, and broadcast
  sends in one helper so profile/source/destination/group field propagation
  stays consistent across send paths.
- Broadened BLZ ZCL receive handling to process any non-ZDO, non-Touchlink,
  non-Green-Power profile as ZCL, so custom-profile ZCL responses are not
  dropped after custom-profile sends.
- Cancelled pending ZCL response waiters when endpoint APS request throws,
  preventing unstarted adapter waiters from remaining in memory after lower
  request failures.
- Removed dead BLZ UART parser state (`rejectCondition` and the unused stored
  ACK sequence field), so malformed frames are logged without retaining a stale
  error marker on the serial driver.
- Removed the dead `dataRequestAttempt` parameter from BLZ endpoint ZCL sends
  and changed the debug log to report only the active response retry attempt and
  queue depth.
- Reset the BLZ watchdog failure counter after a successful reconnect, so stale
  heartbeat misses from a previous connection cannot immediately trigger a reset
  on the new connection.
- Extended shared `Waitress` unstarted-promise cleanup to explicit
  `reject(payload, message)` calls, matching the existing `remove()` and
  `clear()` behavior and avoiding unhandled rejections before `start()`.
- Replaced `Blz` serial-driver listener cleanup with stable bound handlers and
  targeted `off()` calls for `received`, `close`, and `reset`, avoiding broad
  `removeAllListeners()` on the long-lived UART driver.
- Replaced high-level `Driver` cleanup of `Blz` listeners with stable bound
  handlers and targeted `off()` calls for `close`, `reset`, and `frame`, so
  driver-owned listeners are detached without clearing unrelated listeners.
- Made TCP UART open reject and clean up when the socket closes before `ready`,
  preventing a connection attempt from remaining pending without an `error`
  event.
- Made serial UART close release the serial-port reference and destroy the port
  even when `asyncFlushAndClose()` rejects, avoiding a retained port object after
  close failure.

## Next Steps

1. Continue auditing BLZ driver startup/network cache state that should be reset
   across fresh network formation or coordinator restart.
