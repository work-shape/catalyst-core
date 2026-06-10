import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { createApiClient } from "@agent-chat-platform/api-client";
import { signInWithEmail } from "./auth-client";
import { createThemeStyle } from "./theme";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

export function LoginPanel({
  apiBaseUrl,
  manageDocumentTitle,
  onSignedIn
}: {
  apiBaseUrl: string;
  manageDocumentTitle?: boolean;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const client = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const brandingQuery = useQuery({
    queryKey: ["branding", apiBaseUrl],
    queryFn: client.branding,
    retry: false
  });
  const branding = brandingQuery.data;
  const clientName = branding?.clientName ?? "Agent Chat";
  const themeStyle = createThemeStyle(branding);

  useEffect(() => {
    if (!manageDocumentTitle || !branding?.title) {
      return undefined;
    }
    const previousTitle = document.title;
    document.title = branding.title;
    return () => {
      if (document.title === branding.title) {
        document.title = previousTitle;
      }
    };
  }, [branding?.title, manageDocumentTitle]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const result = await signInWithEmail({
      apiBaseUrl,
      email,
      password
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message ?? "Sign in failed");
      return;
    }
    onSignedIn();
  }

  return (
    <main
      className="grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground"
      aria-label="Sign in"
      style={themeStyle}
    >
      <Card className="w-full max-w-[380px]">
        <CardHeader className="gap-4">
          {branding?.logoUrl ? (
            <div className="mx-auto flex h-14 w-full max-w-[230px] items-center justify-center rounded-lg border bg-card px-3">
              <img className="max-h-10 w-full object-contain" src={branding.logoUrl} alt="" />
            </div>
          ) : (
            <div className="grid size-11 place-items-center rounded-lg border bg-card text-primary">
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
          )}
          <CardTitle className="leading-tight">Sign in to {clientName}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSubmit}>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Email</span>
              <Input
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Password</span>
              <Input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending || !email || !password}>
              {pending ? "Signing in" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
