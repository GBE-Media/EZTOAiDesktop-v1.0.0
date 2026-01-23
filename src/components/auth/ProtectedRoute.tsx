import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();

  // Debug logging for packaged builds
  console.log('[ProtectedRoute] isLoading:', isLoading, 'user:', user ? 'exists' : 'null');

  if (isLoading) {
    return (
      <div 
        className="h-screen w-screen flex items-center justify-center bg-background"
        style={{ 
          height: '100vh', 
          width: '100vw', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: '#0a0a0a'
        }}
      >
        <div className="flex flex-col items-center gap-4" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <Loader2 className="h-8 w-8 animate-spin text-primary" style={{ width: 32, height: 32, color: '#3b82f6' }} />
          <p className="text-sm text-muted-foreground" style={{ color: '#a1a1aa', fontSize: 14 }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    console.log('[ProtectedRoute] No user, redirecting to /login');
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
