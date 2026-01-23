import { useAuth } from '@/hooks/useAuth';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { LogOut, User, ChevronDown, Moon, Sun, Download } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  if (!user) return null;

  const displayName = user.email?.split('@')[0] || 'User';
  const isDark = theme === 'dark';

  useEffect(() => {
    if (!window.electronAPI?.onUpdateAvailable) return;

    const cleanupChecking = window.electronAPI.onUpdateChecking(() => {
      setIsCheckingUpdates(true);
    });
    const cleanupAvailable = window.electronAPI.onUpdateAvailable(() => {
      setIsCheckingUpdates(false);
      toast({ title: 'Update available', description: 'Downloading in the background…' });
    });
    const cleanupNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {
      setIsCheckingUpdates(false);
      toast({ title: 'No updates found', description: 'You are on the latest version.' });
    });
    const cleanupDownloaded = window.electronAPI.onUpdateDownloaded(() => {
      setIsCheckingUpdates(false);
      setUpdateReady(true);
      setShowUpdateDialog(true);
    });
    const cleanupError = window.electronAPI.onUpdateError((error) => {
      setIsCheckingUpdates(false);
      toast({ title: 'Update check failed', description: error?.message || 'Please try again.' });
    });

    return () => {
      cleanupChecking?.();
      cleanupAvailable?.();
      cleanupNotAvailable?.();
      cleanupDownloaded?.();
      cleanupError?.();
    };
  }, [toast]);

  const handleCheckForUpdates = async () => {
    if (!window.electronAPI?.checkForUpdates) {
      toast({ title: 'Unavailable', description: 'Updates are only available in the desktop app.' });
      return;
    }

    setIsCheckingUpdates(true);
    toast({ title: 'Checking for updates…', description: 'Please wait.' });

    const result = await window.electronAPI.checkForUpdates();
    if (result.status === 'unavailable') {
      setIsCheckingUpdates(false);
      toast({ title: 'Unavailable', description: result.message || 'Updates are not available here.' });
    } else if (result.status === 'error') {
      setIsCheckingUpdates(false);
      toast({ title: 'Update check failed', description: result.message || 'Please try again.' });
    }
  };

  const handleInstallUpdate = async () => {
    if (!window.electronAPI?.installUpdate) return;
    
    toast({ title: 'Installing update…', description: 'The app will restart shortly.' });
    await window.electronAPI.installUpdate();
  };

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-7 px-2 text-xs gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <User className="h-3.5 w-3.5" />
          <span className="max-w-[120px] truncate">{displayName}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 bg-popover border-border">
        <div className="px-3 py-2 text-sm text-muted-foreground border-b border-border">
          {user.email}
        </div>
        
        {/* Dark Mode Toggle */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            {isDark ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm">Dark Mode</span>
          </div>
          <Switch 
            checked={isDark} 
            onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
          />
        </div>

        {updateReady ? (
          <DropdownMenuItem
            onClick={() => setShowUpdateDialog(true)}
            className="cursor-pointer text-primary"
          >
            <Download className="h-4 w-4 mr-2" />
            Install Update
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={isCheckingUpdates}
            onClick={handleCheckForUpdates}
            className="cursor-pointer"
          >
            {isCheckingUpdates ? 'Checking for updates…' : 'Check for updates'}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        
        <DropdownMenuItem 
          onClick={signOut} 
          className="text-destructive cursor-pointer focus:text-destructive focus:bg-destructive/10"
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    {/* Update Ready Dialog */}
    <AlertDialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update Ready to Install</AlertDialogTitle>
          <AlertDialogDescription>
            A new version of EZTO Ai has been downloaded. Would you like to restart the app now to install the update?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Later</AlertDialogCancel>
          <AlertDialogAction onClick={handleInstallUpdate}>
            Restart & Install
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
