"use client";

import { useEffect, useRef, useState, type SVGProps, type ComponentType } from "react";
import { motion, useInView, type Variants } from "framer-motion";
import { Zap, TrendingUp, Users, Layers } from "lucide-react";
import { WatermarkPattern } from "@/components/shared/watermark-pattern";
import { cn } from "@/lib/utils";

type OutcomeColor = "blue" | "mint" | "purple" | "sky";

interface Outcome {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  color: OutcomeColor;
  badge: string;
  title: string;
  description: string;
  metricValue: number;
  metricSuffix: string;
  metricLabel: string;
  gradient: string;
}

const outcomes: Outcome[] = [
  {
    icon: Zap,
    color: "blue",
    badge: "24×7",
    title: "Faster",
    description: "Response times across support, sales and internal requests",
    metricValue: 60,
    metricSuffix: "%",
    metricLabel: "Average Faster Response",
    gradient: "from-royal to-[#2C5CB0]",
  },
  {
    icon: TrendingUp,
    color: "mint",
    badge: "Scalable",
    title: "Higher",
    description: "Throughput on repetitive, high-volume work",
    metricValue: 2.5,
    metricSuffix: "×",
    metricLabel: "Higher Throughput",
    gradient: "from-saffron to-gold",
  },
  {
    icon: Users,
    color: "purple",
    badge: "Human First",
    title: "More Time",
    description: "For human teams to focus on relationships and decisions",
    metricValue: 30,
    metricSuffix: "%",
    metricLabel: "More Time For High-Value Work",
    gradient: "from-royal to-[#2C5CB0]",
  },
  {
    icon: Layers,
    color: "sky",
    badge: "Enterprise",
    title: "Consistent",
    description: "Policy-aligned answers across every department",
    metricValue: 99,
    metricSuffix: "%",
    metricLabel: "Consistent, Policy-Aligned Answers",
    gradient: "from-saffron to-gold",
  },
];

const colorStyles: Record<OutcomeColor, { bg: string; text: string }> = {
  blue: { bg: "bg-[#E3EEFC]", text: "text-[#2C5CB0]" },
  mint: { bg: "bg-[#E1F5EA]", text: "text-[#1E8F58]" },
  purple: { bg: "bg-[#EDE7F9]", text: "text-[#6B4FA0]" },
  sky: { bg: "bg-[#E1F6F8]", text: "text-[#2389A0]" },
};

const headingVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
};

const gridVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

function AnimatedMetric({ value, suffix }: { value: number; suffix: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const [display, setDisplay] = useState(0);
  const decimals = Number.isInteger(value) ? 0 : 1;

  useEffect(() => {
    if (!inView) return;
    const duration = 1200;
    const start = performance.now();
    let frame: number;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      setDisplay(Number((value * progress).toFixed(decimals)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, value, decimals]);

  return (
    <span ref={ref}>
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export function OutcomesSection() {
  return (
    <section className="relative overflow-hidden bg-[#FFF9F2] py-9">
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(242,140,0,0.1),transparent_70%)] blur-2xl"
        aria-hidden="true"
      />
      <WatermarkPattern
        variant="mandala"
        className="absolute -left-32 -top-32 h-[420px] w-[420px] text-royal opacity-[0.04]"
      />
      <WatermarkPattern
        variant="network"
        className="absolute -bottom-16 -right-16 h-[380px] w-[380px] text-saffron opacity-[0.04]"
      />

      <div className="relative mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={headingVariants}
          className="mx-auto max-w-[720px] text-center"
        >
          <div className="mb-3 flex items-center justify-center gap-2 text-saffron">
            <span aria-hidden="true">✦</span>
            <span className="text-[14px] font-semibold uppercase tracking-[0.2em]">Business Outcomes</span>
          </div>
          <h2 className="font-display text-4xl font-extrabold leading-[1.15] text-royal sm:text-[38px] lg:text-[44px]">
            Outcomes Teams Notice First
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            AI employees don&apos;t just automate work. They help organisations become faster, more consistent and
            more productive.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.15 }}
          variants={gridVariants}
          className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {outcomes.map((item) => (
            <motion.div
              key={item.title}
              variants={cardVariants}
              className="group relative flex flex-col rounded-card border border-[#EEF2F7] bg-white p-5 shadow-md transition-all duration-[220ms] ease-out hover:-translate-y-1.5 hover:border-royal/40 hover:shadow-lg"
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className={cn(
                    "flex h-[52px] w-[52px] items-center justify-center rounded-xl transition-transform duration-[220ms] group-hover:scale-105",
                    colorStyles[item.color].bg,
                    colorStyles[item.color].text
                  )}
                >
                  <item.icon className="h-6 w-6" aria-hidden="true" />
                </div>
                <span
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                    colorStyles[item.color].bg,
                    colorStyles[item.color].text
                  )}
                >
                  {item.badge}
                </span>
              </div>

              <h3 className="mt-4 text-[24px] font-bold leading-tight text-royal">{item.title}</h3>
              <p className="mt-2 text-[17px] leading-[1.7] text-muted">{item.description}</p>

              <div className="my-4 h-px w-full bg-[#EEF2F7]" aria-hidden="true" />

              <div className="mt-auto">
                <p
                  className={cn(
                    "bg-gradient-to-r bg-clip-text text-[42px] font-extrabold leading-none text-transparent",
                    item.gradient
                  )}
                >
                  <AnimatedMetric value={item.metricValue} suffix={item.metricSuffix} />
                </p>
                <p className="mt-2 text-sm text-muted">{item.metricLabel}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
