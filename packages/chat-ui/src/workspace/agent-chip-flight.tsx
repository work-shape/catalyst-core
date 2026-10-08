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
import { AGENT_CHIP_NAME_SELECTOR } from "./agent-selector";

const FLIGHT_MS = 360;
const FLIGHT_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * Carries the agent chip from the centre of the start page into the header
 * when the first message is sent.
 *
 * Only one of the two chips is visible at a time. The start page's chip is the
 * origin: it is measured on departure and from then on only keeps its place,
 * so the heading and composer stay where they are. The header chip is the one
 * that travels: it mounts at its final position and is moved there from the
 * origin's rectangle, which is why the route change that follows the first
 * message neither interrupts nor repeats the flight.
 *
 * The header names the agent more quietly than the start page. The name's
 * colour eases to that on the way; its weight cannot ease in every font, so it
 * is the header's from the first frame, where the lift-off hides the change.
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

/** What the eye saw on the start page at the moment the chip left it. */
interface DepartedChip {
  rect: DOMRect;
  nameColor: string | undefined;
}

export function useAgentChipFlightState(onStartPage: boolean): AgentChipFlight {
  const originRef = useRef<HTMLDivElement>(null);
  const destinationRef = useRef<HTMLDivElement>(null);
  const departedChipRef = useRef<DepartedChip | undefined>(undefined);
  const [departed, setDeparted] = useState(false);

  // Once the route has left the start page it keeps the chip in the header by
  // itself, and the next visit to the start page begins with the chip there.
  if (departed && !onStartPage) {
    setDeparted(false);
  }

  useLayoutEffect(() => {
    const origin = departedChipRef.current;
    const chip = destinationRef.current;
    departedChipRef.current = undefined;
    if (
      !departed ||
      !origin ||
      !chip ||
      typeof chip.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timing = { duration: FLIGHT_MS, easing: FLIGHT_EASING };
    const destination = chip.getBoundingClientRect();
    chip.animate(
      [
        {
          transform: `translate(${origin.rect.left - destination.left}px, ${origin.rect.top - destination.top}px)`
        },
        { transform: "none" }
      ],
      timing
    );
    const name = chip.querySelector(AGENT_CHIP_NAME_SELECTOR);
    if (name && origin.nameColor) {
      name.animate([{ color: origin.nameColor }, { color: getComputedStyle(name).color }], timing);
    }
  }, [departed]);

  const depart = useCallback(() => {
    const origin = originRef.current;
    const name = origin?.querySelector(AGENT_CHIP_NAME_SELECTOR);
    departedChipRef.current = origin
      ? {
          rect: origin.getBoundingClientRect(),
          nameColor: name ? getComputedStyle(name).color : undefined
        }
      : undefined;
    setDeparted(true);
  }, []);
  const cancel = useCallback(() => setDeparted(false), []);

  return useMemo(
    () => ({ chipInHeader: !onStartPage || departed, originRef, destinationRef, depart, cancel }),
    [cancel, depart, departed, onStartPage]
  );
}
