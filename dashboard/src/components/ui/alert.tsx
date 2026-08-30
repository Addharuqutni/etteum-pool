import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-md border px-3 py-2.5 text-[13px]",
  {
    variants: {
      variant: {
        default: "border-[var(--border)] bg-[var(--secondary)]/50 text-[var(--foreground)]",
        success: "border-[var(--success)]/25 bg-[var(--success)]/10 text-[var(--success)]",
        warning: "border-[var(--warning)]/25 bg-[var(--warning)]/10 text-[var(--warning)]",
        error: "border-[var(--error)]/25 bg-[var(--error)]/10 text-[var(--error)]",
        info: "border-[var(--info)]/25 bg-[var(--info)]/10 text-[var(--info)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="alert"
        className={cn(alertVariants({ variant }), className)}
        {...props}
      />
    );
  }
);
Alert.displayName = "Alert";

export { Alert, alertVariants };
