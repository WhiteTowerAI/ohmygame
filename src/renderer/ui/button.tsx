import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import "./button.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className = "",
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ui-button ui-button-${variant} ui-button-${size} ${className}`}
      {...props}
    >
      {icon ? <span className="ui-button-icon">{icon}</span> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  active?: boolean;
  size?: "sm" | "md";
  children: ReactNode;
}

export function IconButton({
  label,
  active = false,
  size = "md",
  className = "",
  children,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={`ui-icon-button ui-icon-button-${size}${active ? " is-active" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
