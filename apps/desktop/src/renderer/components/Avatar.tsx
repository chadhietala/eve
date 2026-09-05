import { avatarColor, initials } from "../lib/avatar.js";

export function Avatar({
  color,
  name,
  size = "md",
}: {
  readonly color?: string;
  readonly name: string;
  readonly size?: "lg" | "md";
}) {
  return (
    <span
      aria-hidden="true"
      className={size === "lg" ? "avatar avatar--lg" : "avatar"}
      style={{ background: avatarColor(name, color) }}
    >
      {initials(name)}
    </span>
  );
}
