import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
};

const ERRORS: Record<string, string> = {
  oauth_denied: "EVE login was cancelled. Try again when ready.",
  session_expired: "Your session ended. Sign in again to pick up where you left off.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  return (
    <main className="launch">
      <div className="launch__panel">
        <img
          className="launch__seal"
          src="/brand/seal.webp"
          alt="Zoo Landers mission seal"
          width={180}
          height={180}
        />
        <h1 className="launch__title">Zoo Landers</h1>
        <p className="launch__motto">
          Center for kids
          <br />
          who can&rsquo;t fly good
        </p>
        {message && (
          <p className="notice notice--bad" data-glyph="!" role="alert">
            {message}
          </p>
        )}
        <a className="launch__action" href="/auth/eve/login">
          <img
            src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-large.png"
            alt="Log in with EVE Online"
            width={270}
            height={45}
          />
        </a>
        <p className="launch__foot">Est. MMXXV · [FLYGD]</p>
      </div>
    </main>
  );
}
