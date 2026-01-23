import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import Index from "./pages/Index";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Hook to handle window close events from Electron
function useWindowCloseHandler() {
  useEffect(() => {
    if (!window.electronAPI?.onCheckUnsavedChanges) return;
    
    const cleanup = window.electronAPI.onCheckUnsavedChanges(() => {
      // For now, always allow close. 
      // TODO: In the future, check for unsaved changes from PDF editor state
      const hasUnsavedChanges = false;
      
      if (hasUnsavedChanges) {
        const confirmed = window.confirm('You have unsaved changes. Are you sure you want to exit?');
        if (confirmed) {
          window.electronAPI?.confirmClose();
        } else {
          window.electronAPI?.cancelClose();
        }
      } else {
        window.electronAPI?.confirmClose();
      }
    });
    
    return cleanup;
  }, []);
}

const App = () => {
  useWindowCloseHandler();
  
  return (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <HashRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route 
                path="/" 
                element={
                  <ProtectedRoute>
                    <Index />
                  </ProtectedRoute>
                } 
              />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  </ThemeProvider>
  );
};

export default App;
