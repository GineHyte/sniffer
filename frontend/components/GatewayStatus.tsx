"use client";

import { formatAda } from "@/lib/einvoice";
import { Badge, useGatewayConfig } from "./ui";

export function GatewayStatus() {
  const { data, isError } = useGatewayConfig();
  if (isError) return <Badge tone="bad">Gateway nicht erreichbar</Badge>;
  if (!data) return <Badge>Verbinde …</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {data.mode === "mock" && <Badge tone="warn">Mock · keine Zahlungen</Badge>}
      <Badge tone="info">Cardano Preprod</Badge>
      <Badge tone={data.main_ok ? "ok" : "bad"}>{data.main_ok ? "Sniffer online" : "Sniffer offline"}</Badge>
      <Badge>{formatAda(data.price_lovelace)} tADA / Rechnung</Badge>
    </div>
  );
}
