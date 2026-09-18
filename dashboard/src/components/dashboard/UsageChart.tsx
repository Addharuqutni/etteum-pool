import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { modelColor } from "@/lib/utils";

interface UsageChartProps {
  data?: any[];
  period?: string;
  colorsByModel?: Record<string, string>;
}

const defaultData: any[] = [];

function formatTokenCount(value: number) {
  const abs = Math.abs(value);
  const format = (num: number) => Number(num.toFixed(2)).toString();

  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${format(value / 1_000)}K`;
  return value.toString();
}

export default function UsageChart({ data = defaultData, colorsByModel = {} }: UsageChartProps) {
  const models = Object.keys(data[0] || {}).filter((k) => k !== "hour" && k !== "label");
  const colors = Object.fromEntries(models.map((model, index) => [model, colorsByModel[model] || modelColor(model, index)]));

  if (data.length === 0) {
    // One line, no illustration. The operator knows what an empty chart means.
    return (
      <div className="flex h-[260px] w-full items-center justify-center font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
        No traffic in this range
      </div>
    );
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            {models.map((model) => (
              <linearGradient key={model} id={`gradient-${model}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors[model]} stopOpacity={0.22} />
                <stop offset="100%" stopColor={colors[model]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {/* Horizontal rules only — vertical gridlines fight the area shapes */}
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            stroke="var(--chart-axis)"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <YAxis
            stroke="var(--chart-axis)"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value) => formatTokenCount(Number(value))}
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "2 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const sorted = [...payload].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
              return (
                <div className="rounded-md border border-[var(--border)] bg-[var(--popover)] px-2.5 py-2 shadow-[var(--shadow-raised)]">
                  <div className="eyebrow mb-1.5">{label}</div>
                  <table className="font-mono text-[11px]">
                    <tbody>
                      {sorted.map((entry) => (
                        <tr key={entry.name}>
                          <td className="pr-3">
                            <span className="flex items-center gap-1.5">
                              <span
                                aria-hidden
                                className="h-2 w-[3px] rounded-full"
                                style={{ backgroundColor: entry.color }}
                              />
                              <span className="text-[var(--muted-foreground)]">{entry.name}</span>
                            </span>
                          </td>
                          <td className="text-right tabular-nums text-[var(--foreground)]">
                            {formatTokenCount(Number(entry.value || 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }}
          />
          
          {models.map((model) => (
            <Area
              key={model}
              type="monotone"
              dataKey={model}
              stroke={colors[model]}
              fill={`url(#gradient-${model})`}
              strokeWidth={1.5}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
