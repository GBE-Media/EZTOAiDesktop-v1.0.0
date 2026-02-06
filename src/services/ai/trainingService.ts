import { externalAuthClient } from '@/integrations/external-auth/client';

export interface TrainingCountEntry {
  type: string;
  quantity: number;
  notes?: string;
}

export interface TrainingMaterialPayload {
  userId: string;
  file: File;
  projectName?: string;
  pageScope: 'current' | 'all' | 'selection';
  trade: 'electrical' | 'plumbing' | 'hvac';
  counts: TrainingCountEntry[];
  notes?: string;
}

export interface TrainingContextQuery {
  userId: string;
  trade: 'electrical' | 'plumbing' | 'hvac';
  projectName?: string;
  limit?: number;
}

export const uploadTrainingMaterial = async (payload: TrainingMaterialPayload) => {
  const { userId, file, projectName, pageScope, trade, counts, notes } = payload;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/training-data/${timestamp}-${safeName}`;
  const supabaseUrl = (externalAuthClient as unknown as { supabaseUrl?: string }).supabaseUrl;

  console.warn('[AI Training] Supabase URL:', supabaseUrl || 'unknown');
  console.warn('[AI Training] Upload path:', storagePath);
  const sessionResult = await externalAuthClient.auth.getSession();
  const sessionUserId = sessionResult.data.session?.user?.id;
  const accessToken = sessionResult.data.session?.access_token || '';
  console.warn('[AI Training] Auth session user:', sessionUserId || 'none');
  console.warn('[AI Training] Access token prefix:', accessToken.slice(0, 16) || 'none');

  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error('Please sign in again before uploading training data.');
  }

  const { error: uploadError } = await externalAuthClient.storage
    .from('ai-training')
    .upload(storagePath, file, { contentType: file.type || 'application/pdf' });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: publicUrl } = externalAuthClient.storage
    .from('ai-training')
    .getPublicUrl(storagePath);

  const { error: insertError } = await externalAuthClient
    .from('ai_training_entries')
    .insert({
      user_id: userId,
      project_name: projectName || file.name,
      file_url: publicUrl?.publicUrl || null,
      file_name: file.name,
      page_scope: pageScope,
      trade,
      counts_json: counts,
      notes: notes || null,
    });

  if (insertError) {
    throw new Error(insertError.message);
  }
};

export const fetchTrainingContext = async ({
  userId,
  trade,
  projectName,
  limit = 3,
}: TrainingContextQuery): Promise<string> => {
  let query = externalAuthClient
    .from('ai_training_entries')
    .select('project_name, file_name, counts_json, notes, page_scope, created_at')
    .eq('user_id', userId)
    .eq('trade', trade)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (projectName) {
    query = query.ilike('project_name', `%${projectName}%`);
  }

  const { data, error } = await query;

  if (error || !data || data.length === 0) {
    return '';
  }

  const entries = data.map((entry) => {
    const counts = Array.isArray(entry.counts_json) ? entry.counts_json : [];
    const countLines = counts
      .map((count: TrainingCountEntry) => {
        const note = count.notes ? ` (${count.notes})` : '';
        return `- ${count.type}: ${count.quantity}${note}`;
      })
      .join('\n');

    const header = [
      entry.project_name || entry.file_name || 'Training entry',
      entry.page_scope ? `Scope: ${entry.page_scope}` : null,
    ].filter(Boolean).join(' | ');

    return `Entry: ${header}\n${countLines}${entry.notes ? `\nNotes: ${entry.notes}` : ''}`;
  });

  return `Verified training data:\n${entries.join('\n\n')}`;
};
