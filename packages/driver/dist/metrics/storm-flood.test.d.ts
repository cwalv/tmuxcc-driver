/**
 * Integration-style test: synthetic notification flood trips the storm alarm (tc-x6l).
 *
 * Validates the full path: pipeline.onNotification → metricsRegistry.incTopologyEvent
 * + stormAlarm.record → alarm trips on sustained rate.
 *
 * No live tmux needed — uses a fake clock and direct stormAlarm driving.
 */
export {};
//# sourceMappingURL=storm-flood.test.d.ts.map