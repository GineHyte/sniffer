import Link from "next/link";
import { CaseDetail } from "@/components/CaseDetail";

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm text-ink-2 hover:underline">
        ← Back to upload
      </Link>
      <CaseDetail caseId={caseId} />
    </div>
  );
}
