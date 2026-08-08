import Link from "next/link";

export default function NotFound() {
  return (
    <main className="center-screen">
      <p className="kicker">404</p>
      <h1>That page isn&apos;t here.</h1>
      <Link className="secondary" href="/">Return to Ponsbot</Link>
    </main>
  );
}
