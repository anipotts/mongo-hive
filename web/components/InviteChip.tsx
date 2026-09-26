import { createHiveInvite } from "@/app/actions";
import { Copy } from "@/components/Copy";
import { connectCommand, invitePrompt, invites } from "../../src/hive/invites";

// invite teammates from the hive title row: creates a code, shows the command and a prompt to paste
export async function InviteChip({ hive, code }: { hive: string; code?: string }) {
  const inv = code ? await invites.findOne({ _id: code, hive }) : null;
  return (
    <details className="pchip invite" open={!!inv}>
      <summary><b>+ invite</b></summary>
      <div className="pchip-pop">
        {inv ? (
          <>
            <div className="muted small">invite <span className="mono">{inv._id}</span> · 24h · no credentials inside</div>
            <div className="inv-row"><code className="mono">{connectCommand(inv._id)}</code><Copy text={connectCommand(inv._id)} /></div>
            <pre className="inv-prompt">{invitePrompt(inv)}</pre>
            <Copy text={invitePrompt(inv)} label="copy prompt" />
          </>
        ) : (
          <form action={createHiveInvite}>
            <input type="hidden" name="hive" value={hive} />
            <p className="muted small">Make a one-day invite code for {hive}. Your teammate runs one command; it sets up their own Atlas login.</p>
            <button className="primary">create invite</button>
          </form>
        )}
      </div>
    </details>
  );
}
