import { redirect } from "next/navigation";
import { getWorkspaceId } from "../lib/getWorkspaceId";
import { getAccountForWorkspace } from "../lib/accountAuth";
import { safeNextPath } from "../lib/safeRedirect";
import { RegisterForm } from "./RegisterForm";

export const metadata = { title: "Create account - StreamLift" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(
    Array.isArray(params.next) ? params.next[0] : params.next,
  );

  const workspaceId = await getWorkspaceId();
  if (workspaceId && (await getAccountForWorkspace(workspaceId))) {
    redirect(next);
  }

  return <RegisterForm next={next} />;
}
