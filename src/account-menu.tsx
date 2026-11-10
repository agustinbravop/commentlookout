import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type SignedInUser = { id: string; email: string; name: string; picture: string | null };

export function AccountMenu({ user }: { user: SignedInUser }) {
  return <>
    <form id="account-sign-out" action="/api/auth/logout" method="post" hidden />
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Account menu" />}>
        <Avatar size="lg"><AvatarImage src={user.picture || undefined} alt="" referrerPolicy="no-referrer" /><AvatarFallback>{user.name.trim().charAt(0).toUpperCase() || '?'}</AvatarFallback></Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40"><DropdownMenuGroup>
        <DropdownMenuItem render={<a href="/home" />}>Your workspace</DropdownMenuItem>
        <DropdownMenuItem nativeButton render={<button type="submit" form="account-sign-out" />}>Sign out</DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
  </>;
}
