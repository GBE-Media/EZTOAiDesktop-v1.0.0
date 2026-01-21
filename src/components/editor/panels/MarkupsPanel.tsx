import { useState } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Cloud, 
  MessageSquare, 
  Highlighter,
  Lock,
  MoreVertical,
  Search,
  Filter,
  SortAsc
} from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { Input } from '@/components/ui/input';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';

const iconMap: Record<string, React.ReactNode> = {
  cloud: <Cloud className="w-3 h-3" />,
  callout: <MessageSquare className="w-3 h-3" />,
  highlight: <Highlighter className="w-3 h-3" />,
};

export function MarkupsPanel() {
  const { documents, activeDocument, selectedMarkups, selectMarkup, clearSelection } = useEditorStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPages, setExpandedPages] = useState<number[]>([1, 2]);

  const doc = documents.find((d) => d.id === activeDocument);
  const markups = doc?.markups ?? [];

  const filteredMarkups = markups.filter((m) => 
    (m.label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (m.author || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const markupsByPage = filteredMarkups.reduce((acc, markup) => {
    if (!acc[markup.page]) acc[markup.page] = [];
    acc[markup.page].push(markup);
    return acc;
  }, {} as Record<number, typeof markups>);

  const togglePage = (page: number) => {
    setExpandedPages((prev) => 
      prev.includes(page) 
        ? prev.filter((p) => p !== page)
        : [...prev, page]
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search and filter bar */}
      <div className="p-2 border-b border-panel-border space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder="Search markups..."
            className="h-7 pl-7 text-xs bg-secondary border-none"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          <button className="toolbar-button !w-auto px-2 gap-1 text-[10px]">
            <Filter className="w-3 h-3" />
            Filter
          </button>
          <button className="toolbar-button !w-auto px-2 gap-1 text-[10px]">
            <SortAsc className="w-3 h-3" />
            Sort
          </button>
        </div>
      </div>

      {/* Markups list */}
      <div className="flex-1 overflow-auto">
        {Object.entries(markupsByPage).map(([page, pageMarkups]) => (
          <div key={page}>
            {/* Page header */}
            <button
              className="w-full flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary border-b border-panel-border"
              onClick={() => togglePage(Number(page))}
            >
              {expandedPages.includes(Number(page)) ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Page {page}
              <span className="ml-auto text-[10px] bg-secondary px-1.5 py-0.5 rounded">
                {pageMarkups.length}
              </span>
            </button>

            {/* Markup items */}
            {expandedPages.includes(Number(page)) && (
              <div className="py-1">
                {pageMarkups.map((markup) => (
                  <div
                    key={markup.id}
                    className={`list-item ${selectedMarkups.includes(markup.id) ? 'selected' : ''}`}
                    onClick={(e) => selectMarkup(markup.id, e.ctrlKey || e.metaKey)}
                  >
                    {/* Color indicator and icon */}
                    <div 
                      className="w-3 h-3 rounded-sm flex items-center justify-center"
                      style={{ backgroundColor: markup.color + '30', color: markup.color }}
                    >
                      {iconMap[markup.type] || <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: markup.color }} />}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs">{markup.label}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {markup.author} · {markup.date}
                      </div>
                    </div>

                    {/* Status indicators */}
                    <div className="flex items-center gap-1">
                      {markup.locked && (
                        <Lock className="w-3 h-3 text-muted-foreground" />
                      )}
                      <div 
                        className={`w-1.5 h-1.5 rounded-full ${
                          markup.status === 'accepted' ? 'bg-status-success' :
                          markup.status === 'rejected' ? 'bg-status-error' :
                          'bg-status-warning'
                        }`}
                        title={markup.status}
                      />
                    </div>

                    {/* Actions */}
                    <DropdownMenu>
                      <DropdownMenuTrigger className="opacity-0 group-hover:opacity-100 hover:bg-secondary rounded p-0.5">
                        <MoreVertical className="w-3 h-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-xs">
                        <DropdownMenuItem>Edit</DropdownMenuItem>
                        <DropdownMenuItem>Duplicate</DropdownMenuItem>
                        <DropdownMenuItem>Lock</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {filteredMarkups.length === 0 && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No markups found
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="px-2 py-1.5 border-t border-panel-border text-[10px] text-muted-foreground flex justify-between">
        <span>{markups.length} markups</span>
        <span>{selectedMarkups.length} selected</span>
      </div>
    </div>
  );
}
