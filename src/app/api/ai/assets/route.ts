import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { loadAiConfig } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'video/quicktime',
]);

function assetType(mime: string): 'pdf' | 'image' | 'video' | null {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

async function extractPdfText(
  apiKey: string,
  model: string,
  bytes: ArrayBuffer,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  const upload = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!upload.ok)
    throw new Error(`OpenAI file upload failed (${upload.status})`);
  const file = (await upload.json()) as { id?: string };
  if (!file.id) throw new Error('OpenAI did not return a file id');

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Extract the complete useful text from this PDF for a CRM knowledge base. Preserve headings, prices, dates, tables as readable text, and do not summarize or invent anything. Return only the extracted content.',
              },
              { type: 'input_file', file_id: file.id },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok)
      throw new Error(`OpenAI PDF analysis failed (${response.status})`);
    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text =
      data.output_text ||
      (data.output ?? [])
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('\n');
    if (!text.trim())
      throw new Error('OpenAI returned no extractable PDF text');
    return text.trim();
  } finally {
    await fetch(`https://api.openai.com/v1/files/${file.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => undefined);
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('ai_assets')
      .select('id,title,file_name,mime_type,asset_type,created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ assets: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const form = await request.formData();
    const file = form.get('file');
    const titleValue = form.get('title');
    if (!(file instanceof File))
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_BYTES)
      return NextResponse.json(
        { error: 'Arquivo inválido ou maior que 100 MB.' },
        { status: 400 }
      );
    if (!ALLOWED.has(file.type))
      return NextResponse.json(
        { error: 'Formato não suportado. Use PDF, imagem ou vídeo.' },
        { status: 400 }
      );
    const type = assetType(file.type);
    if (!type)
      return NextResponse.json(
        { error: 'Formato não suportado.' },
        { status: 400 }
      );
    if (type === 'image' && file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'Imagens para envio pelo WhatsApp devem ter no máximo 5 MB.' },
        { status: 400 }
      );
    }
    if (type === 'video' && file.size > MAX_VIDEO_BYTES) {
      return NextResponse.json(
        { error: 'Vídeos para envio pelo WhatsApp devem ter no máximo 16 MB.' },
        { status: 400 }
      );
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${accountId}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from('ai-assets')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) throw uploadError;

    let extractedText: string | null = null;
    if (type === 'pdf') {
      const config = await loadAiConfig(supabase, accountId, {
        requireActive: false,
      });
      if (!config || config.provider !== 'openai') {
        await supabase.storage.from('ai-assets').remove([path]);
        return NextResponse.json(
          {
            error:
              'Para indexar PDFs automaticamente, configure uma chave OpenAI na IA do CRM.',
          },
          { status: 400 }
        );
      }
      extractedText = await extractPdfText(
        config.apiKey,
        config.model,
        await file.arrayBuffer(),
        file.name
      );
    }

    const title =
      typeof titleValue === 'string' && titleValue.trim()
        ? titleValue.trim()
        : file.name.replace(/\.[^.]+$/, '');
    const { data: asset, error: insertError } = await supabase
      .from('ai_assets')
      .insert({
        account_id: accountId,
        created_by: userId,
        title,
        file_name: file.name,
        mime_type: file.type,
        asset_type: type,
        storage_path: path,
        extracted_text: extractedText,
      })
      .select('id,title,file_name,mime_type,asset_type,created_at')
      .single();
    if (insertError || !asset) {
      await supabase.storage
        .from('ai-assets')
        .remove([path])
        .catch(() => undefined);
      throw insertError ?? new Error('Failed to save asset');
    }

    try {
      if (extractedText) {
        const { data: doc, error: docError } = await supabase
          .from('ai_knowledge_documents')
          .insert({
            account_id: accountId,
            created_by: userId,
            title,
            content: extractedText,
          })
          .select('id')
          .single();
        if (docError || !doc)
          throw docError ?? new Error('Failed to create knowledge document');
        const { key: embeddingsApiKey } = await import('@/lib/ai/config').then(
          (m) => m.loadEmbeddingsKey(supabase, accountId)
        );
        await ingestDocument(
          supabase,
          accountId,
          { embeddingsApiKey },
          doc.id,
          extractedText
        ).catch((err) =>
          console.warn(
            '[ai/assets] PDF lexical ingest succeeded but semantic indexing failed:',
            err
          )
        );
      }
    } catch (error) {
      // Keep the uploaded asset usable even if the knowledge indexing step
      // fails. The PDF is still available in the library for retry/review.
      console.error('[ai/assets] knowledge indexing failed:', error);
    }

    return NextResponse.json({ success: true, asset });
  } catch (err) {
    console.error('[ai/assets POST]', err);
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id)
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const { data: asset } = await supabase
      .from('ai_assets')
      .select('storage_path')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (!asset)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await supabase.storage.from('ai-assets').remove([asset.storage_path]);
    const { error } = await supabase
      .from('ai_assets')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
