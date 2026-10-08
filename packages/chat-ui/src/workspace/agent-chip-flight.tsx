import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { AGENT_CHIP_BESIDE_ICON_SELECTOR, AGENT_CHIP_ICON_SELECTOR } from "./agent-selector";

const FLIGHT_MS = 360;
const FLIGHT_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** The name is gone within the first third of the flight, before the icon is far away. */
const NAME_FADE_MS = FLIGHT_MS / 3;

/**
 * Carries the agent's icon from the centre of the start page into the header
 * when the first message is sent.
 *
 * Only one of the two chips is visible at a time. The start page's chip is the
 * origin: its icon is measured on departure and from then on the chip only
 * keeps its place, so the heading and composer stay where they are. The header
 * chip is the one that travels: it mounts at its final position and is moved
 * there from where the origin's icon was, which is why the route change that
 * follows the first message neither interrupts nor repeats the flight.
 *
 * The header shows the icon alone. A name beside the icon on the start page
 * does not travel: it fades out where it stands while the icon lifts off.
 */
export interface AgentChipFlight {
  /** False while the start page shows the chip above its heading. */
  chipInHeader: boolean;
  originRef: RefObject<HTMLDivElement | null>;
  destinationRef: RefObject<HTMLDivElement | null>;
  /** The first message is on its way: the chip leaves now, not when the server answers. */
  depart(): void;
  /** The first message did not go out, so the chip is back on the start page. */
  cancel(): void;
}

const groundedFlight: AgentChipFlight = {
  chipInHeader: false,
  originRef: { current: null },
  destinationRef: { current: null },
  depart: () => undefined,
  cancel: () => undefined
};

const AgentChipFlightContext = createContext<AgentChipFlight>(groundedFlight);

export function useAgentChipFlight(): AgentChipFlight {
  return useContext(AgentChipFlightContext);
}

export function AgentChipFlightProvider({
  flight,
  children
}: {
  flight: AgentChipFlight;
  children: ReactNode;
}) {
  return (
    <AgentChipFlightContext.Provider value={flight}>{children}</AgentChipFlightContext.Provider>
  );
}

function iconRectOf(chip: Element): DOMRect {
  return (chip.querySelector(AGENT_CHIP_ICON_SELECTOR) ?? chip).getBoundingClientRect();
}

export function useAgentChipFlightState(onStartPage: boolean): AgentChipFlight {
  const originRef = useRef<HTMLDivElement>(null);
  const destinationRef = useRef<HTMLDivElement>(null);
  const departedIconRef = useRef<DOMRect | undefined>(undefined);
  const [departed, setDeparted] = useState(false);

  // Once the route has left the start page it keeps the chip in the header by
  // itself, and the next visit to the start page begins with the chip there.
  if (departed && !onStartPage) {
    setDeparted(false);
  }

  useLayoutEffect(() => {
    const originIcon = departedIconRef.current;
    const chip = destinationRef.current;
    departedIconRef.current = undefined;
    if (
      !departed ||
      !originIcon ||
      !chip ||
      typeof chip.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const icon = iconRectOf(chip);
    chip.animate(
      [
        {
          transform: `translate(${originIcon.left - icon.left}px, ${originIcon.top - icon.top}px)`
        },
        { transform: "none" }
      ],
      { duration: FLIGHT_MS, easing: FLIGHT_EASING }
    );
    // The origin chip is hidden by now; what stood beside its icon stays
    // visible for as long as it takes to fade.
    const fades = Array.from(
      originRef.current?.querySelectorAll(AGENT_CHIP_BESIDE_ICON_SELECTOR) ?? [],
      (left) =>
        left.animate(
          [
            { opacity: 1, visibility: "visible" },
            { opacity: 0, visibility: "visible" }
          ],
          { duration: NAME_FADE_MS, easing: "ease-out" }
        )
    );
    // A first message that does not go out puts the chip back on the start
    // page: whatever is still fading then is shown in full at once.
    return () => {
      for (const fade of fades) {
        fade.cancel();
      }
    };
  }, [departed]);

  const depart = useCallback(() => {
    const origin = originRef.current;
    departedIconRef.current = origin ? iconRectOf(origin) : undefined;
    setDeparted(true);
  }, []);
  const cancel = useCallback(() => setDeparted(false), []);

  return useMemo(
    () => ({ chipInHeader: !onStartPage || departed, originRef, destinationRef, depart, cancel }),
    [cancel, depart, departed, onStartPage]
  );
}
