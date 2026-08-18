// Silences React's act() warnings for the scenario suite. Import this BEFORE
// anything that pulls in @testing-library/react.
//
// act() assumes the test drives every state update. The scenario suite doesn't,
// and shouldn't: it runs the real app against real storage, so the engine
// reports progress on its own schedule while bytes move over a real socket.
// Those updates land whenever they land — including inside the act() windows
// that RTL opens around render() and each user-event call, which is why setting
// IS_REACT_ACT_ENVIRONMENT alone can't win the race (RTL flips it back to true
// for the duration of those calls and restores it after).
//
// So the flag below handles updates outside those windows, and the filter
// handles the ones inside them. Every warning suppressed here is React
// reporting that the app behaved normally; an unfiltered run printed 147 of
// them. The filter is deliberately narrow — it matches only this one message,
// and every other console.error still goes straight through, so a genuine
// React error (a bad hook call, a render crash) is as loud as ever.
// SAFETY: IS_REACT_ACT_ENVIRONMENT is a React Testing Library convention, not
// a declared global — this is the documented way to set it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const ACT_WARNING = "was not wrapped in act";
const realError = console.error.bind(console);

function isStringValue(cause: unknown): cause is string {
  return typeof cause === "string";
}

console.error = (...args: unknown[]) => {
  if (isStringValue(args[0]) && args[0].includes(ACT_WARNING)) return;
  realError(...args);
};
