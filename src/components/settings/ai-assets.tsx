'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileUp, Loader2, Trash2, FileText, Image as ImageIcon, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Asset { id: string; title: string; file_name: string; mime_type: string; asset_type: 'pdf'|'image'|'video'; created_at: string }

export function AiAssets({ canEdit }: { canEdit: boolean }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/assets');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Falha ao carregar arquivos');
      setAssets(data.assets ?? []);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Falha ao carregar arquivos'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function upload() {
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (title.trim()) form.append('title', title.trim());
      const res = await fetch('/api/ai/assets', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Falha no upload');
      toast.success(file.type === 'application/pdf' ? 'PDF processado e adicionado à base de conhecimento.' : 'Arquivo adicionado à biblioteca da IA.');
      setTitle('');
      if (inputRef.current) inputRef.current.value = '';
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Falha no upload'); }
    finally { setUploading(false); }
  }

  async function remove(id: string) {
    if (!confirm('Excluir este arquivo da biblioteca da IA?')) return;
    const res = await fetch('/api/ai/assets', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
    if (res.ok) { setAssets((x) => x.filter((a) => a.id !== id)); toast.success('Arquivo removido.'); }
    else { const data = await res.json(); toast.error(data.error ?? 'Falha ao excluir'); }
  }

  const icon = (type: Asset['asset_type']) => type === 'pdf' ? <FileText className="size-4" /> : type === 'image' ? <ImageIcon className="size-4" /> : <Video className="size-4" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileUp className="size-4 text-primary" /> Biblioteca da IA</CardTitle>
        <CardDescription>PDFs viram conhecimento pesquisável. Imagens e vídeos ficam disponíveis para o agente encaminhar pelo WhatsApp.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título opcional" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input ref={inputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp,video/quicktime" />
            <Button onClick={() => void upload()} disabled={uploading}>{uploading ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />} Adicionar</Button>
          </div>
        </div>}
        {loading ? <Loader2 className="size-5 animate-spin" /> : assets.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum arquivo adicionado.</p> : (
          <div className="divide-y rounded-lg border border-border">
            {assets.map((asset) => <div key={asset.id} className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-center gap-3">{icon(asset.asset_type)}<div className="min-w-0"><p className="truncate text-sm font-medium">{asset.title}</p><p className="truncate text-xs text-muted-foreground">{asset.file_name}</p></div></div>
              {canEdit && <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => void remove(asset.id)}><Trash2 className="size-4" /></Button>}
            </div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
