'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Plus, Trash2, ListFilter, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ContactList } from '@/types';

interface Props {
  selectedListId: string | null;
  onSelect: (listId: string | null) => void;
  canManage: boolean;
  refreshKey?: number;
}

export function ContactListsPanel({
  selectedListId,
  onSelect,
  canManage,
  refreshKey = 0,
}: Props) {
  const supabase = createClient();
  const [lists, setLists] = useState<ContactList[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('contact_lists')
      .select('*')
      .order('name');
    if (error) toast.error(`Falha ao carregar listas: ${error.message}`);
    setLists((data ?? []) as ContactList[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // The async load updates state after the Supabase request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  async function createList() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const { data: sessionData } = await supabase.auth.getSession();
    const user = sessionData.session?.user;
    const { data: profile } = user
      ? await supabase
          .from('profiles')
          .select('account_id')
          .eq('user_id', user.id)
          .maybeSingle()
      : { data: null };
    if (!user || !profile?.account_id) {
      toast.error('Conta não encontrada.');
      setSaving(false);
      return;
    }
    const { data, error } = await supabase
      .from('contact_lists')
      .insert({
        name: trimmed,
        user_id: user.id,
        account_id: profile.account_id,
      })
      .select('*')
      .single();
    if (error) {
      toast.error(
        error.code === '23505'
          ? 'Já existe uma lista com esse nome.'
          : `Falha ao criar lista: ${error.message}`
      );
    } else {
      toast.success('Lista criada.');
      setName('');
      setOpen(false);
      await load();
      if (data) onSelect(data.id);
    }
    setSaving(false);
  }

  async function deleteList(list: ContactList) {
    if (
      !confirm(
        `Excluir a lista "${list.name}"? Os contatos não serão excluídos.`
      )
    )
      return;
    const { error } = await supabase
      .from('contact_lists')
      .delete()
      .eq('id', list.id);
    if (error) toast.error(`Falha ao excluir lista: ${error.message}`);
    else {
      if (selectedListId === list.id) onSelect(null);
      await load();
      toast.success('Lista excluída.');
    }
  }

  return (
    <div className="border-border bg-card/60 rounded-xl border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <ListFilter className="text-primary size-4" />
          Listas de contatos
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> Nova lista
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={selectedListId === null ? 'default' : 'outline'}
          size="sm"
          onClick={() => onSelect(null)}
        >
          Todos
        </Button>
        {loading ? (
          <Loader2 className="m-2 size-4 animate-spin" />
        ) : (
          lists.map((list) => (
            <div key={list.id} className="group flex items-center">
              <Button
                variant={selectedListId === list.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => onSelect(list.id)}
                className="rounded-r-none"
              >
                {list.name}
              </Button>
              {canManage && (
                <Button
                  variant={selectedListId === list.id ? 'default' : 'outline'}
                  size="icon-sm"
                  onClick={() => void deleteList(list)}
                  className="rounded-l-none border-l-0"
                  title="Excluir lista"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Nova lista de contatos</DialogTitle>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Leads Street Garden"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createList();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void createList()}
              disabled={saving || !name.trim()}
            >
              {saving && <Loader2 className="size-4 animate-spin" />} Criar
              lista
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
