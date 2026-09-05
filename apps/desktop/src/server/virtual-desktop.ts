import { virtualComputer, type ComputerBackend } from "eve/computer";

/**
 * A simulated screen, used when the desktop runs somewhere with no display —
 * a container, CI, or a first look at the app before wiring it to a real
 * machine. Selected with `EVE_DESKTOP_COMPUTER=virtual`.
 */
export function virtualDesktop(): ComputerBackend {
  const computer = virtualComputer({
    height: 720,
    title: "eve virtual desktop",
    width: 1_120,
  });

  let opened = "nothing";
  computer.setElements([
    {
      bounds: [48, 96, 220, 64],
      fill: "#0070f3",
      id: "inbox",
      label: "INBOX",
      onActivate: () => {
        opened = "inbox";
        render();
      },
    },
    {
      bounds: [48, 184, 220, 64],
      id: "deploys",
      label: "DEPLOYS",
      onActivate: () => {
        opened = "deploys";
        render();
      },
    },
    {
      bounds: [48, 272, 220, 64],
      id: "terminal",
      label: "TERMINAL",
      onActivate: () => {
        opened = "terminal";
        render();
      },
    },
    { bounds: [312, 96, 760, 240], fill: "#171717", id: "stage", label: "OPENED: NOTHING" },
    { bounds: [312, 368, 760, 240], fill: "#111111", id: "typed", label: "TYPED: " },
  ]);

  return {
    id: computer.id,
    async execute(action, context) {
      const result = await computer.execute(action, context);
      if (action.action === "type" || action.action === "key") render();
      return result;
    },
  };

  function render(): void {
    computer.setElements(
      computer.elements.map((element) => {
        if (element.id === "stage") return { ...element, label: `OPENED: ${opened}` };
        if (element.id === "typed") {
          return { ...element, label: `TYPED: ${computer.typed.slice(-40)}` };
        }
        return element;
      }),
    );
  }
}
