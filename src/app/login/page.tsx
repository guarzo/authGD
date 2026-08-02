export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main style={{ maxWidth: 480, margin: "10vh auto", textAlign: "center" }}>
      <h1>authGD</h1>
      <p>Corporation auth for FlyGD.</p>
      {error === "oauth_denied" && (
        <p role="alert">EVE login was cancelled. Try again when ready.</p>
      )}
      <a href="/auth/eve/login">
        <img
          src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-large.png"
          alt="Log in with EVE Online"
        />
      </a>
    </main>
  );
}
