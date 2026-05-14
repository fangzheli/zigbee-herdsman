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
- Enforced declared BLZ byte-field lengths during frame parsing, so
  `value`/`payload`/`message` fields are sliced to their schema length and
  malformed truncated or trailing byte data is rejected before reaching upper
  layers.
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
- Made high-level `Driver.stop()` release its `Blz` instance reference even when
  `blz.close()` rejects, while still clearing waiters and address caches in the
  outer cleanup path.
- Routed synthetic `LEAVE_REQUEST` device-leave handling through
  `Driver.handleNodeLeft()` so BLZ clears cached NWK/EUI mappings before the
  adapter emits `deviceLeave`.
- Added adapter-level stop generation and cancellable waits for BLZ channel
  change, so `stop()` rejects an in-flight channel-change delay and prevents
  follow-on leave/reform operations after shutdown begins.
- Made UART port `close` events perform the same waiter/queue/parser and
  port/socket reference cleanup as explicit close paths, so unexpected serial
  disconnects do not retain closed port objects.
- Replaced UART serial-port/parser listener cleanup with stable bound handlers
  and targeted `off()` calls for `parsed`, `close`, and `error`, avoiding broad
  listener removal on the serial path.
- Replaced UART TCP socket listener cleanup with an owned detach closure and
  targeted `off()` calls for open-time and runtime socket listeners, avoiding
  broad listener removal on the TCP path.
- Replaced BLZ adapter-to-driver event registration with stable bound handlers
  and explicit attach/detach guards, so successful adapter stop releases
  driver listeners without breaking restart or failed-stop close handling.
- Added a UART operation generation guard so reset, close, or port-close cleanup
  cancels active `sendDATA()` retry loops immediately instead of allowing stale
  sends to retry after waiter cleanup.
- Added high-level driver request generation and cancellable APS retry waits, so
  `Driver.stop()` interrupts active unicast retry delays instead of leaving
  requests pending until the retry window expires.
- Added BLZ transport connect generation and cancellable connect retry waits, so
  `Blz.close()` interrupts a failed-connect retry delay and prevents another
  serial connection attempt after shutdown begins.
- Reused the adapter cancellable wait path for group and broadcast ZCL settle
  delays, so `BLZAdapter.stop()` rejects active settle waits instead of leaving
  queue work pending until the fixed delay expires.
- Added cancellable UART send retry waits, so close/reset/port-close cleanup
  interrupts a `sendDATA()` retry sleep instead of leaving the send promise
  pending until the one-second retry delay expires.
- Reused the adapter cancellable wait path for the startup settle delay, so
  `BLZAdapter.stop()` rejects an in-flight `start()` settle wait instead of
  allowing startup to resolve after shutdown begins.
- Added cancellable high-level driver reset delays, so an external
  `Driver.stop()` interrupts reset backoff waits immediately instead of leaving
  the reset promise alive until the fixed delay expires.
- Added high-level driver startup generation checks and cancellable startup
  delays, so `Driver.stop()` interrupts startup settle waits and prevents later
  initialization steps from running against a stopped BLZ instance.
- Extracted repeated cancellable delay bookkeeping into a BLZ-local
  `CancellableDelay` helper and reused it for UART send retries, BLZ connect
  retries, high-level APS retries, reset delays, and startup delays.
- Wrapped BLZ transport connect attempts in `try/finally` so the temporary
  reconnect reset listener is detached even when close cancels a retry delay.
- Added adapter stop-generation checks around endpoint ZCL response recovery,
  so `BLZAdapter.stop()` does not let a cleared response waiter trigger a
  recovery retry or leave the original send promise pending.
- Added the same adapter stop-generation guard to ZDO sends, preventing an
  in-flight lower request from resolving after `BLZAdapter.stop()` and running
  follow-up work such as synthetic leave cache cleanup/events.
- Restored the BLZ transport reset-state flag when a high-level driver reset is
  cancelled by external stop, so the old transport object does not remain marked
  as resetting after the reset flow exits early.
- Added BLZ watchdog generation checks, so an in-flight heartbeat that finishes
  after `Blz.close()` or watchdog cleanup cannot count a stale failure or emit a
  reset event after the transport has been closed.
- Coalesced concurrent high-level `Driver.startup()` calls into one startup
  promise, preventing overlapping startup attempts from closing or replacing
  each other's BLZ transport instance.
- Coalesced concurrent lower-level `Blz.connect()` calls into one connect
  promise, preventing overlapping serial open attempts and duplicate temporary
  reconnect listeners on the same UART driver.
- Added BLZ command connection-generation checks, so active command queue work
  cannot resolve successfully after `Blz.close()` or reconnect changes the
  underlying serial connection.
- Replaced the BLZ adapter's hand-rolled stop-waiter timer set with the shared
  BLZ `CancellableDelay` helper, keeping stop cancellation behavior consistent
  with UART, transport, and high-level driver waits.
- Extended shared `Queue.clear()` to reject active jobs as well as queued jobs.
  BLZ adapter stop and BLZ transport close now pass domain-specific cancellation
  errors so callers do not stay pending behind lower-layer operations after
  lifecycle teardown begins.
- Added UART open-phase cancellation for both serial and TCP connections, so
  `SerialDriver.close()` rejects an in-flight `connect()` before the port is
  fully opened/ready and releases parser, pipe, and port/socket references.
- Replaced the BLZ transport's temporary connect-time reset listener `throw`
  with an attempt-scoped abort promise, so reset events during connect flow
  through the same cleanup and retry path instead of escaping the EventEmitter
  callback while the connect promise remains ambiguous.
- Added a BLZ transport connect-attempt close abort, so `Blz.close()` rejects
  an in-flight lower serial `connect()` immediately instead of relying on the
  UART layer to settle the pending attempt.
- Added a high-level driver startup-connect abort, so `Driver.stop()` rejects
  `Driver.startup()` while it is still awaiting `Blz.connect()` and releases the
  newly-created BLZ instance without waiting on lower-layer behavior.
- Added a high-level driver reset-force abort, so `Driver.stop()` resolves an
  in-flight `Driver.reset()` that is still awaiting `Blz.forceReset()` and
  clears the BLZ reset-state flag.
- Generalized the high-level startup cancellation path into
  `runStartupOperation()`, and used it for both `Blz.connect()` and
  `Blz.forceReset()` so startup cannot remain pending behind either lower-layer
  operation after stop begins.
- Extended `runStartupOperation()` to the startup endpoint registration step,
  so `Driver.stop()` also rejects startup promptly while `addEndpoint()` is
  pending.
- Extended `runStartupOperation()` to the startup version probe, so
  `Driver.stop()` does not leave startup pending while `Blz.getVersion()` is
  in flight.
- Extended `runStartupOperation()` to the startup network validation step, so
  `Driver.stop()` also rejects startup while `needsToBeInitialised()` is
  waiting on lower BLZ commands.
- Extended `runStartupOperation()` to the final startup network-parameter and
  coordinator IEEE queries, so `Driver.stop()` cannot leave startup pending
  while those last BLZ commands are in flight.
- Extended `runStartupOperation()` to startup network restore-decision and
  leave-network steps, so `Driver.stop()` rejects startup promptly while backup
  inspection or current-network leave is still pending.
- Extended `runStartupOperation()` to startup network formation and restore, so
  `Driver.stop()` also rejects startup while `formNetwork()` is still pending.
- Added a BLZ transport connect-operation cancellation wrapper and used it for
  reconnect pre-close, so `Blz.close()` rejects reconnect while the old serial
  driver close is still pending.
- Reused the connect-operation cancellation wrapper for failed-attempt cleanup,
  so `Blz.close()` also rejects connect while cleanup is still closing a failed
  serial attempt.
- Added adapter-level start-operation cancellation, so `BLZAdapter.stop()`
  rejects an in-flight `start()` even while it is still awaiting
  `Driver.startup()`.
- Coalesced concurrent `BLZAdapter.start()` calls into one start promise, so
  overlapping starts do not duplicate driver startup or overwrite each other's
  stop-cancellation hook.
- Generalized adapter stop cancellation to in-flight operations and applied it
  to channel-change lower calls, so `BLZAdapter.stop()` rejects channel change
  while it is still reading keys, leaving, updating security, or reforming the
  network.
- Reused adapter operation cancellation for coordinator permit-join requests,
  so `BLZAdapter.stop()` rejects `permitJoin()` while the lower coordinator
  request is still pending.
- Reused adapter operation cancellation for backup creation, so
  `BLZAdapter.stop()` rejects `backup()` while backup collection is still
  pending.
- Added high-level driver request-operation cancellation, so `Driver.stop()`
  resolves active unicast requests while EUI64 lookup or APS send is still
  pending instead of waiting for the lower BLZ operation to settle.
- Reused high-level driver request-operation cancellation for multicast and
  broadcast APS sends, so direct `mrequest()` and `brequest()` calls also
  resolve on stop while the lower send is still pending.
- Reused high-level driver request-operation cancellation for standalone
  `networkIdToEUI64()` lookups, so `Driver.stop()` rejects the lookup while the
  lower address query is still pending.
- Extracted repeated stop/request cancellation bookkeeping into a BLZ
  `CancellableOperation` helper and reused it from the adapter and high-level
  driver, so operation rejecters are always cleared and late caller handlers do
  not produce unhandled rejections.
- Reused `CancellableOperation` for high-level driver startup operations,
  replacing the single ad-hoc startup reject hook while preserving the existing
  stop-on-startup cancellation behavior.
- Reused `CancellableOperation` for BLZ transport connect operations,
  replacing the ad-hoc connect close hook while preserving connect retry,
  reconnect pre-close, and reset-during-connect behavior.
- Reused `CancellableOperation` for high-level driver reset-force operations,
  replacing the ad-hoc reset-force reject hook while preserving stop-cancelled
  reset behavior.
- Reused `CancellableOperation` for UART open-phase serial/TCP connects and
  guarded TCP ready-reset completion, so `close()` cannot let a pending TCP
  connect mark the driver initialized after teardown.
- Delayed the high-level driver runtime reset listener until startup finishes,
  so the expected startup force-reset event cannot recursively launch reset
  recovery while startup owns the BLZ instance.
- Made `Blz.close(true)` emit the BLZ-level `close` event itself after targeted
  serial-listener teardown, preserving explicit close notification without
  relying on the detached serial bridge.
- Routed BLZ incoming message type into adapter ZCL payload `wasBroadcast`, so
  broadcast ZCL messages no longer use the old hard-coded `false` placeholder.
- Normalized `bigint` EUI64 values from BLZ `deviceJoinCallback` frames before
  address-cache insertion, so real uint64 join callbacks do not throw or skip
  cache cleanup/update paths.
- Removed stale EUI64-to-node cache entries by cached node ID during leave
  handling, so a leave event with a different IEEE cannot leave old send
  mappings retained.
- Treated resolved node ID `0x0000` as a valid address lookup result, so EUI64
  sends to the coordinator are not retried and failed as unknown.
- Reused `CancellableOperation` for BLZ reset-during-connect cancellation,
  replacing the attempt-local abort promise while preserving failed-attempt
  cleanup, retry, and close cancellation behavior.
- Made high-level startup fail immediately when the final network-parameter
  probe returns a non-success BLZ status, instead of continuing to coordinator
  IEEE lookup after the stack failed to report valid network parameters.
- Routed direct high-level driver BLZ command helpers through the existing
  request-operation cancellation path, so `Driver.stop()` now rejects pending
  permit-join, endpoint registration, network-key, and trust-center-key
  operations instead of leaving their callers waiting on lower BLZ commands.
- Moved backup network-parameter and coordinator-MAC reads behind high-level
  driver command wrappers, so backup creation no longer reaches directly into
  the lower BLZ transport and those reads share the same stop-cancellation and
  status-check behavior as the other driver command helpers.
- Hardened startup network validation so a stack-down result, non-success
  network-parameter status, mismatched coordinator identity, or missing extended
  PAN ID is treated as "needs initialization" without parsing absent fields.
- Made high-level startup reject when the BLZ `formNetwork` command returns a
  non-success status, preventing startup from continuing into final probes after
  network formation failed and avoiding stale address-cache retention on failed
  formation.
- Extended adapter queue ownership for BLZ NWK-update channel changes so the
  broadcast, propagation wait, leave, security updates, re-form, and settle wait
  run as one serialized job. A second channel-change request no longer overlaps
  the first long-running network rebuild.
- Cleared cached BLZ coordinator and network snapshots during driver stop, and
  cleared cached network parameters after successful fresh network formation, so
  stop/restart and re-form paths do not expose stale coordinator or network
  state to adapter callers.
- Added an adapter-level stop barrier, so `BLZAdapter.start()` waits for an
  in-flight `BLZAdapter.stop()` to finish before calling `Driver.startup()`.
  This prevents driver startup from overlapping driver shutdown and avoids a
  completed stop detaching listeners from a newly-started adapter.
- Preserved explicit BLZ-level close notification when `Blz.close(true)` reaches
  a lower serial-driver close failure, while still propagating the original
  close error to the caller.
- Added a BLZ transport close barrier, so `Blz.connect()` waits for an in-flight
  `Blz.close()` before reconnecting and cannot start a second lower serial close
  while the first close is still pending.
- Added a high-level driver stop barrier, so concurrent `Driver.stop()` calls
  share one lower `Blz.close()` while still applying each caller's stop
  cancellation side effects.
- Preserved explicit BLZ close events when a `Blz.close(true)` caller joins an
  already-running silent `Blz.close(false)`, so coalesced close calls do not
  drop the later caller's notification requirement.
- Fixed the shared queue's keyed scheduling so numeric key `0` is treated as a
  real serialization key. This matters for BLZ sends keyed by coordinator
  network address `0x0000`.
- Split startup network validation and formation into per-step cancellable
  operations, so `Driver.stop()` cannot reject startup while still allowing a
  late `networkInit()` or network-key update to continue into follow-on BLZ
  commands against a stopped transport.
- Added a stop guard to BLZ backup creation and checked it between each driver
  read, so an adapter stop cannot reject `backup()` while the underlying backup
  collector continues into later network/security reads. Backup creation also
  reads the BLZ version without retaining the whole transport object across the
  async collection flow.
- Tightened parser tail retention further: when corrupted input contains
  garbage before an incomplete START-delimited frame, only the partial frame
  from START onward is retained for the next chunk.
- Extended endpoint ZCL response-waiter cleanup to synchronous pre-send
  failures such as node-cache/EUI64 conversion errors, preventing unstarted
  adapter waiters from remaining in memory until shutdown.
- Fixed high-level driver waiter address matching so coordinator network
  address `0x0000` is matched as a real address instead of being treated as a
  wildcard.
- Reduced outgoing raw-frame allocation churn further by making CRC append,
  CRC verification, and raw frame construction write into preallocated buffers
  instead of using `Buffer.concat()` for header/payload/CRC assembly.
- Added a high-level `Driver.isInitialized()` API and moved BLZ adapter permit
  join checks off the public `driver.blz` transport field, reducing adapter
  coupling to driver internals.
- Moved coordinator version reads, backup initialization checks, channel-change
  leave, and channel-change re-form calls behind high-level `Driver` APIs, so
  the BLZ adapter and backup collector no longer reach directly into the lower
  BLZ transport.
- Moved backup creation behind `Driver.createBackup()` and made the driver's
  backup manager private, so `BLZAdapter` no longer reaches into a driver-owned
  helper object during stop-cancellable backup collection.
- Made the high-level driver's lower BLZ transport private, keeping adapter and
  backup callers on driver-owned APIs instead of retaining access to
  transport-owned state.
- Made the high-level driver's cached network-parameter snapshot private as
  well, keeping mutable network state behind defensive snapshot/update APIs.
- Made the high-level driver's lower-transport getter private, so callers
  cannot retain the BLZ transport object through a public escape hatch.
- Hardened the UART serial driver against direct repeated `connect()` calls by
  closing any existing serial/socket resource before opening a replacement,
  avoiding orphaned pipes, listeners, or port references at the lower layer.
- Coalesced concurrent UART `connect()` calls behind one in-flight promise, so
  parallel opens do not race close/cancel/open paths against the same port.
- Coalesced concurrent UART `close()` calls behind one in-flight promise, so a
  second close cannot destroy a port while the first flush-close is still
  pending.
- Made the low-level BLZ transport and UART waiter factories private, keeping
  request waiter ownership inside their respective lifecycle cleanup paths.
- Made the BLZ adapter's driver-close event handler private, so disconnected
  emission stays owned by the adapter's attached driver listener.
- Removed unused public BLZ transport leftovers (`cmdSeq` and `makeZDOframe()`),
  reducing mutable and command-construction surface not owned by current flows.
- Removed unused BLZ transport ZDO frame-data classes and made
  `BlzMultiAddress` reject unsupported address modes instead of silently
  serializing them as group/NWK-style addresses.
- Removed the remaining legacy BLZ ZDO command tables and ZDO-only helper
  types after the adapter moved to shared ZDO payload construction over the BLZ
  APS send path.
- Made the driver's transaction sequence allocator private, keeping APS frame
  sequence mutation behind `makeApsFrame()`.
- Detached adapter-owned driver listeners when startup fails, preventing a
  failed start attempt from retaining callbacks on the driver instance.
- Made the BLZ transport's cached version private and exposed it through a
  defensive snapshot, preventing callers from mutating transport-owned metadata.
- Changed high-level driver coordinator-version and network-parameter snapshot
  getters to return defensive copies, preventing callers from retaining and
  mutating driver-owned cached state.
- Changed the high-level driver coordinator IEEE getter to return a defensive
  `BlzEUI64` copy and made the cached coordinator IEEE private, preventing
  callers from mutating driver-owned coordinator identity state.
- Hardened `BlzEUI64.value` to return a copy of its backing storage, so any
  caller that receives an EUI64 cannot mutate the original object through the
  exposed byte array.
- Hardened `BlzEUI64` construction from array-like values to copy the input
  bytes, preventing later mutation of the caller-owned buffer from changing the
  EUI64 object.
- Fixed generic BLZ list serialization to use the declared item type and fixed
  length-prefixed lists to write the actual item count, keeping type
  serialization consistent without retaining unnecessary intermediate arrays.
- Aligned raw `Bytes.deserialize()` with the generic schema contract by
  returning an empty remaining buffer, preventing future non-terminal raw byte
  fields from poisoning subsequent deserialization state.
- Fixed generic BLZ fixed-list serialization to emit every byte produced by the
  declared item type and reject mismatched item counts, preventing truncated or
  shifted schema payloads.
- Hardened BLZ length-prefixed bytes and lists to reject truncated payloads or
  missing length headers instead of silently producing short values.
- Reworked `BlzEUI64.serialize()` to write the fixed eight-byte reversed value
  directly into a preallocated buffer, avoiding per-byte integer serialization
  and intermediate array churn.
- Reworked NWK update channel-change payload normalization to preallocate the
  canonical payload and write optional TSN/manager-address fields directly,
  avoiding repeated `Buffer.concat()` in the channel-change entry path.
- Added a shared preallocating BLZ frame-field serializer for command and ZDO
  frame data classes, replacing per-frame `Buffer.concat(result)` in the BLZ
  command serialization hot path.
- Avoided `Buffer.concat()` in both common and fragmented parser paths, and
  replaced the remaining BLZ type/schema/struct serialization concatenations
  with preallocated buffer copies.
- Removed the unused `disableResponse` argument from high-level APS frame
  construction, keeping response-waiter decisions at the adapter layer where
  they are actually used.
- Reused adapter-level cancellable operations for ZDO sends and ZCL endpoint,
  group, and broadcast lower driver sends, so `BLZAdapter.stop()` can release
  active adapter jobs without waiting for lower send promises to settle.
- Removed unused legacy high-level driver request parameters from unicast and
  multicast APS sends, keeping retry and timeout ownership in the existing
  request cancellation helpers.
- Added the missing schema-level empty-buffer guard for BLZ length-prefixed
  byte deserialization, so malformed payloads fail before any out-of-bounds
  buffer read.
- Made the BLZ adapter device-join event handler synchronous, avoiding a
  needless Promise allocation and keeping EventEmitter callback errors on the
  synchronous listener path.
- Made UART parsed-frame and error-frame handlers synchronous, avoiding
  per-frame Promise allocation on the serial receive hot path.
- Added a BLZ transport receive guard for undersized raw frames, so malformed
  serial data is logged and discarded before frame-ID reads can throw from the
  EventEmitter listener.
- Contained BLZ transport frame decoding failures at the receive boundary, so
  unknown or malformed frame IDs are logged and discarded instead of escaping
  from the serial EventEmitter callback.
- Simplified the BLZ adapter unsupported `reset()` path to throw directly like
  the other unsupported adapter APIs, removing a stale `return await
  Promise.reject(...)` pattern.
- Made the high-level driver BLZ reset EventEmitter handler synchronous and
  explicitly logged reset recovery failures, avoiding an unconsumed async
  listener promise on runtime reset events.
- Made the UART TCP socket `ready` EventEmitter handler synchronous by moving
  reset/open completion work into an internal async helper, keeping open errors
  on the existing cleanup path without returning a Promise to EventEmitter.
- Validated parsed backup data before reading backup metadata and replaced
  legacy `Promise.resolve/reject` returns in the async backup loader with native
  `return` and `throw` paths.
- Made BLZ frame decode fallback explicit: `BLZFrameData.createFrame()` now
  advertises that all parser candidates can fail and returns `undefined`
  without a non-null assertion.
- Guarded BLZ transport waiter matching for unknown numeric frame IDs, returning
  a clean non-match instead of throwing from the waiter validator.
- Removed the UART serial-port constructor `@ts-ignore` by preserving literal
  serial option types with `as const`.
- Aligned high-level `Driver.stop(true)` with the lower BLZ/UART close
  semantics: explicit close requests now emit one driver `close` event, even
  when they join an in-flight silent stop.
- Cleaned high-level driver state on unexpected lower BLZ close events:
  pending request/startup/reset operations and waiters are cancelled, BLZ
  listeners are detached, cached network state is cleared, and the lower BLZ
  reference is released before emitting `close`.
- Cleaned BLZ adapter state on unexpected high-level driver close events:
  adapter delays, queued jobs, ZCL waiters, running operations, and driver
  listeners are released before emitting `disconnected`.
- Contained malformed ZDO response parsing at the high-level driver receive
  boundary, so truncated ZDO payloads are logged and forwarded as raw incoming
  messages without throwing from the BLZ frame EventEmitter listener.
- Replaced remaining `Array.map()` use in BLZ schema, struct, generic-list,
  and fixed-list serialization with a preallocating mapped-buffer helper,
  removing extra callback/intermediate-array churn from serialization paths.
- Removed the now-unused `serializeBufferSegments()` helper from the BLZ type
  layer after moving all local serialization call sites to the mapped-buffer
  helper.
- Guarded BLZ ZCL receive matching against reserved frame types, so malformed
  ZCL headers are still emitted as raw payloads but no longer resolve response
  waiters as if they were valid ZCL frames.
- Made the UART receive boundary verify CRC on every parsed frame, not only
  frames with the debug/control bit set, so corrupted DATA frames are dropped
  before ACK or upper-layer emission.
- Hardened BLZ byte unstuffing to reject a dangling escape byte at the end of a
  frame instead of silently dropping it and passing a shortened frame further
  into the receive path.
- Kept the high-level driver's cached network channel mask aligned with cached
  channel state: startup now stores the NCP `channelMask`, and channel-change
  snapshot updates refresh both `Channel` and `channels`.
- Collapsed the BLZ parser's retained tail state from a one-element buffer
  array into a single bounded buffer, matching the current parser behavior and
  reducing the chance of accidental multi-buffer retention growth.
- Tightened BLZ byte unstuffing further so escape sequences must decode to one
  of the reserved delimiter bytes, preventing malformed escaped data from being
  silently rewritten into a different payload.
- Stopped BLZ ZDO sends from mutating caller-owned payload buffers when writing
  the adapter TSN byte; the adapter now sends an internal copy with the BLZ
  sequence applied.
- Tightened `BlzEUI64` internal storage to a private Buffer and made
  `toString()` read that backing store directly, avoiding an extra Buffer copy
  on address-cache and join/leave hot paths while keeping `value` defensive.
- Reworked `BlzEUI64.serialize()` to read instance backing storage directly
  from inside the class, avoiding the defensive `value` getter copy while still
  preserving public immutability.
- Aligned the shared BLZ CRC verifier with `Frame` construction by rejecting
  undersized raw frames before attempting CRC comparison, keeping malformed
  receive errors specific at the helper boundary.
- Reworked `BlzEUI64.deserialize()` to write reversed bytes directly into the
  result buffer, avoiding the intermediate fixed-list array-to-Buffer copy on
  inbound EUI64 parsing.
- Reused a shared empty buffer for raw `Bytes.deserialize()` remainders,
  avoiding per-call empty-buffer allocation on terminal raw byte fields.
- Removed the extra raw-payload copy from NWK update payload normalization;
  the helper now copies the caller payload once into the canonical broadcast
  buffer instead of first cloning it and then copying the clone.
- Reworked BLZ MAC-to-EUI64 conversion to write reversed bytes directly into
  the result buffer, avoiding the `Buffer.from(...).reverse()` copy-and-mutate
  pattern during startup coordinator identity conversion.
- Added direct `BlzEUI64` instance copying and used it for the driver's
  coordinator IEEE snapshot, preserving the defensive copy boundary without
  converting the cached identity through a hex string.
- Removed the adapter-level NWK update raw-payload copy that existed only for
  debug logging; channel-change handling now logs the caller payload directly
  before building its canonical broadcast buffer.
- Reworked backup extended-PAN-ID serialization to write directly into the
  backup buffer, avoiding an intermediate byte array and array-backed
  `Buffer.from()` during backup creation.
- Reworked cancellable operation and delay cancellation to notify their tracked
  pending callbacks by directly iterating the Set, avoiding per-cancel array
  snapshots on stop/reset/close paths while still clearing retained callbacks.
- Tightened BLZ command waiter matching so string frame-name matchers use a
  direct comparison instead of allocating a single-item array and running
  `includes()` on every response-match attempt.
- Reused the shared mapped-buffer serializer for `BLZFrameData` command-field
  serialization, removing the duplicate local buffer-list assembly and dynamic
  `push()` growth in the frame layer.
- Changed fixed-width integer serialization to allocate with `allocUnsafe()`
  because every integer write covers the complete target width, avoiding
  unnecessary zero-fill work on BLZ command serialization.
- Changed startup network-parameter snapshot creation to allocate the
  extended-PAN-ID buffer with `allocUnsafe(8)` because the subsequent
  `writeBigUInt64BE()` covers the complete buffer.
- Changed numeric `setValue()` payload construction to use `allocUnsafe(4)`
  because `writeUInt32LE()` fully initializes the outgoing value buffer.
- Reworked startup extended-PAN-ID comparison to fill a fixed-length
  8-element array by index instead of dynamically growing it with `push()`.
- Tightened BLZ command waiter matching further so unknown numeric frame IDs
  return `false` directly instead of allocating an empty fallback array and
  calling `includes()`.
- Reworked raw `Bytes.serialize()` so Buffer inputs are passed through directly;
  the enclosing frame serializer still copies them into the final frame buffer,
  avoiding an extra clone on raw payload fields.
- Reworked `Fixed16Bytes.serialize()` to return validated Buffer inputs
  directly; the enclosing frame serializer owns the final copy, so network-key
  command fields no longer pay an extra clone first.
- Reworked schema deserialization to preallocate the result array from the
  known schema length and fill by index instead of dynamically growing it with
  `push()`.
- Reworked length-prefixed and fixed-length list deserialization to preallocate
  their known-size result arrays and fill by index, leaving only truly
  unbounded `List.deserialize()` on dynamic growth.
- Reused the shared empty buffer for empty mapped-buffer serialization results,
  avoiding zero-length segment and output-buffer allocations for empty schemas
  or empty typed lists.
- Reworked network formation extended-PAN-ID conversion to read little-endian
  array-like bytes directly into a bigint, avoiding temporary `Buffer.from()`
  clones for configured or backup PAN IDs.
- Reworked restore compatibility checks to compare configured extended-PAN-ID
  and network-key bytes directly, avoiding temporary `Buffer.from()` clones
  while preserving the existing little-endian PAN-ID comparison.
- Reworked new-network key setup to fill a fixed 16-byte buffer directly from
  configured key bytes, avoiding the generic `Buffer.from()` conversion before
  `setNetworkKeyInfo()`.
- Reworked length-prefixed byte serialization to fill array-like inputs
  directly into the prefixed output buffer, avoiding a temporary
  `Buffer.from()` clone before the final copy.
- Reworked raw byte serialization to allocate and fill array-like inputs
  directly through the same local byte-copy helper, keeping Buffer inputs as
  pass-through segments for the enclosing frame serializer.
- Reworked ordinary ZDO payload TSN injection to copy caller-owned buffers with
  one `allocUnsafe()` plus `copy()`, preserving the immutability boundary
  without `Buffer.from(payload)` cloning.
- Reworked network-parameter snapshot extended-PAN-ID copying to use the
  driver fixed-byte helper, preserving the defensive snapshot boundary without
  `Buffer.from()` cloning.
- Reworked backup creation key and coordinator IEEE copies to fill fixed-size
  backup-owned buffers directly, keeping the ownership boundary while avoiding
  generic `Buffer.from(sourceBuffer)` clones.
- Reworked `BlzEUI64` array, copy-constructor, and value-getter defensive
  copies through a fixed 8-byte helper, keeping identity storage isolated
  without generic `Buffer.from()` source-buffer clones.
- Reworked `BlzEUI64` hex-string parsing to fill the fixed 8-byte identity
  buffer directly, avoiding `Buffer.from(hex, "hex")` in address construction.
- Reworked restore-path backup network-key hex parsing to fill a fixed 16-byte
  buffer directly before `setNetworkKeyInfo()`, avoiding `Buffer.from(hex,
  "hex")` on backup restore.
- Reworked the BLZ receive-handler non-Buffer fallback to normalize
  array-like frames with a direct copy helper, avoiding `Buffer.from()` on the
  EventEmitter receive path.
- Consolidated repeated byte-copy and fixed-size hex parsing helpers into a
  shared BLZ byte utility module, so backup, driver, frame receive, and EUI64
  code share the same allocation and validation behavior.
- Detached saved parser partial tails from larger chunk backing stores, so a
  short START-delimited tail after large noisy input does not keep the whole
  serial chunk alive until the next read.
- Reused the same BLZ retention-safe buffer helper for parsed byte fields, so
  `LVBytes`, terminal `Bytes`, and fixed 16-byte security fields do not expose
  subarrays that can retain a larger inbound frame buffer.
- Enforced counted BLZ `WordList` boundaries for `addEndpoint` frame parsing,
  so input and output cluster lists are split by their declared counts instead
  of the first list consuming all remaining request bytes.
- Corrected UART DATA control-flag propagation: initial sends no longer set
  the retransmission bit, and retry sends no longer set the debug bit.
- Added a real `WordList.deserialize()` implementation for uint16 cluster
  lists and reused it from counted frame parsing, so the BLZ type layer no
  longer depends on a generic `List` path that requires an unavailable item
  type.
- Preserved explicit endpoint ZCL `sourceEndpoint` values by replacing truthy
  defaulting with nullish/default-on-entry handling, matching the group send
  path and avoiding accidental endpoint rewrites.
- Made low-level BLZ `getValue()` and `setValue()` fail fast on non-success
  command statuses, preventing startup/version reads or value updates from
  continuing with stale or missing payload data after the NCP reports failure.
- Preserved the original lower-level error as `cause` when `execCommand()`
  wraps send/wait failures, so command callers still get the existing
  high-level failure message without losing the underlying UART or waiter
  evidence.
- Coalesced low-level BLZ watchdog heartbeats so a hung `getVersion()` probe
  cannot accumulate overlapping heartbeat commands or queued promises; watchdog
  generation changes still release the guard for close/reconnect boundaries.
- Cleared low-level BLZ command queues and command waiters before direct
  UART-level `forceReset()`, so reset recovery does not leave pre-reset command
  promises pending while the UART layer resets underneath them.
- Guarded direct UART-level `forceReset()` with the BLZ connection generation,
  preventing a close/reconnect boundary from being followed by a stale reset
  against the old serial driver state.
- Guarded UART `reset()` against an in-flight close before sending the reset
  frame, so close cleanup cannot be followed by a stale writer reset against a
  closing serial or TCP transport.
- Made TCP socket `ready` handling one-shot during UART open, preventing
  repeated `ready` emissions while reset is pending from running duplicate
  reset/open-completion flows or attaching runtime listeners repeatedly.
- Kept TCP open-phase error/close listeners attached until the ready-time reset
  succeeds, so socket failures during reset still reject and clean up the open
  attempt instead of being treated as runtime-only log events.
- Cleaned low-level BLZ state on unexpected serial-driver close events:
  watchdogs, connect operations, retry delays, command queues, command waiters,
  and owned serial-driver listeners are released before emitting BLZ `close`.
- Reused the same low-level BLZ serial-state cleanup for UART reset recovery
  events, so pending BLZ commands and watchdogs are cancelled before the reset
  event is handed to the high-level driver.
- Cancelled high-level driver request operations, retry delays, and ZDO waiters
  immediately when `Driver.reset()` starts, instead of leaving old APS/ZDO
  operations alive until the delayed stop phase runs.
- Cancelled in-flight high-level startup delays and startup operations when
  `Driver.reset()` starts, preventing startup and reset recovery from running
  overlapping BLZ transport flows.
- Ignored new high-level reset requests while an explicit `Driver.stop()` is
  already in progress, preventing reset recovery from sending `forceReset()` or
  restarting against a lower BLZ transport that is already closing.
- Preserved the specific startup cancellation reason when reset interrupts a
  high-level startup delay, and treated reset-cancelled startup cleanup as
  internal reset cleanup so the reset recovery can still restart the driver.
- Preserved adapter-level running-operation cancellation reasons across
  cancellable settle delays, so an unexpected driver close during adapter start
  rejects as `Adapter disconnected` instead of being reported as a normal stop.
- Normalized string IEEE addresses when matching high-level driver waiters, so
  `NETWORK_ADDRESS_RESPONSE` waiters resolve across `0x`/case differences
  instead of being retained until timeout.
- Aligned `BlzEUI64` string construction with the same case-insensitive `0x`
  prefix handling, so callers that pass `0X...` addresses do not fail before
  reaching the normalized driver cache/waiter paths.
- Normalized adapter IEEE string formatting for coordinator lookups,
  coordinator-backed endpoint sends, and device join/leave events through one
  helper, avoiding malformed `0x0X...` addresses from upper-case prefixed
  driver values.
- Extracted BLZ IEEE address normalization/formatting into a shared helper used
  by both adapter event formatting and driver waiter/cache matching, so future
  `0x` prefix behavior changes have one implementation.
- Made high-level driver address-cache reads and writes copy `BlzEUI64`
  objects at the cache boundary, preventing caller-owned or returned address
  objects from mutating cached node mappings.
- Changed expected adapter shutdown to call `Driver.stop(false)`, keeping normal
  stop cleanup on the explicit stop path instead of routing it through the
  driver's close-event/disconnect handler.
- Split TCP socket open-phase and runtime listener cleanup in the BLZ UART
  driver, releasing `connect`/`ready`/open `error`/open `close` handlers as soon
  as ready-time reset succeeds while retaining only runtime `close`/`error`
  handlers until transport close.
- Made UART serial/TCP open-attempt cleanup ownership-aware, so an explicit
  `close()` that cancels an in-flight open releases the port once and the
  abandoned connect path does not detach/destroy the same transport again.
- Serialized public UART `sendDATA()` calls through the same low-level queue as
  resets, preventing concurrent sends from sharing stale `sendSeq` state or
  overlapping response waiters while preserving the existing send-cancel error.
- Extended shared `Waitress.clear()` to accept an explicit rejection reason and
  wired BLZ adapter, high-level driver, low-level BLZ, and UART cleanup paths to
  preserve stop/close/reset causes instead of reporting generic
  `Waitress cleared`.
- Made the BLZ parser resynchronize on a new unescaped START delimiter before
  END, so a corrupted partial frame cannot consume the following valid frame and
  force reset recovery through a stale bad frame.
- Corrected `LVBytes` length deserialization to treat the one-byte length as
  unsigned, so payloads of 128-255 bytes are not truncated by signed length
  interpretation.
- Added symmetric serialize-time validation for BLZ declared byte lengths and
  counted `WordList` fields, preventing internally inconsistent frames from
  being emitted when a length/count property does not match its payload.

## Next Steps

1. Continue auditing remaining BLZ direct lower-transport calls and lifecycle
   edge cases for the same stop/reset cancellation and stale-state patterns.
