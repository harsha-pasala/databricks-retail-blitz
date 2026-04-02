import { ThemeProvider } from "@/components/apx/theme-provider";
import { UserProvider } from "@/lib/UserContext";
import { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: () => (
    <ThemeProvider defaultTheme="dark" storageKey="apx-ui-theme">
      <UserProvider>
        <Outlet />
        <Toaster richColors />
      </UserProvider>
    </ThemeProvider>
  ),
});
