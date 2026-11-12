import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContextSupabase';
import { HashIcon, AlertCircleIcon } from '../../components/icons';
import { EditIcon, DeleteIcon, XIcon, CheckIcon } from '../../components/icons';
import { IconButton } from '../../components/icons/IconButton';
import type { Tag } from '../../contexts/AppContextSupabase';
import PageWrapper from '../../components/PageWrapper';

interface TagFormData {
  name: string;
  color: string;
  description: string;
}

/**
 * A TAG'S COLOUR IS THE USER'S, NOT THE APP'S.
 *
 * This is the value written to `tags.color` in the database and shown in the
 * swatch grid people pick from — the same class of thing as a category's
 * colour, and outside the 28 August stock-blue ruling for the same reason: that
 * ruling retires a stock blue standing in for a DESIGN decision, and nobody's
 * saved tag colour is a design decision. Changing these would rewrite what new
 * rows are stamped with and take a hue out of somebody's colour box, which is
 * behaviour rather than colour.
 *
 * Named once so the lint suppression is written once, next to the reason,
 * rather than five times next to nothing.
 */
// eslint-disable-next-line no-restricted-syntax -- see above: persisted user data, not chrome
const DEFAULT_TAG_COLOUR = '#3B82F6';

/** The ten hues the picker offers. One of them is blue because users like blue. */
const PREDEFINED_COLOURS = [
  DEFAULT_TAG_COLOUR, '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6B7280'
];

export default function Tags() {
  const { tags, addTag, updateTag, deleteTag, getTagUsageCount, getAllUsedTags } = useApp();
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [formData, setFormData] = useState<TagFormData>({
    name: '',
    color: DEFAULT_TAG_COLOUR,
    description: ''
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Get all tags used in transactions that aren't in the centralized list
  const usedTags = getAllUsedTags();
  const unregisteredTags = usedTags.filter((tagName: string) => 
    !tags.some(tag => tag.name === tagName)
  );

  // Auto-create tags from transactions on component mount
  useEffect(() => {
    unregisteredTags.forEach((tagName: string) => {
      addTag({
        name: tagName,
        color: '#6B7280',
        description: 'Auto-created from transaction'
      });
    });
  }, [addTag, unregisteredTags]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Reset errors
    setErrors({});
    
    // Validate form
    const newErrors: Record<string, string> = {};
    
    if (!formData.name.trim()) {
      newErrors.name = 'Tag name is required';
    } else if (tags.some(tag => tag.name.toLowerCase() === formData.name.toLowerCase() && tag.id !== editingTag)) {
      newErrors.name = 'Tag name already exists';
    }
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    
    if (editingTag) {
      // Update existing tag
      updateTag(editingTag, {
        name: formData.name.trim(),
        color: formData.color,
        description: formData.description.trim()
      });
    } else {
      // Add new tag
      addTag({
        name: formData.name.trim(),
        color: formData.color,
        description: formData.description.trim()
      });
    }
    
    // Reset form
    setFormData({
      name: '',
      color: DEFAULT_TAG_COLOUR,
      description: ''
    });
    setEditingTag(null);
  };

  const handleEdit = (tag: Tag) => {
    setFormData({
      name: tag.name,
      color: tag.color || DEFAULT_TAG_COLOUR,
      description: tag.description || ''
    });
    setEditingTag(tag.id);
  };

  const handleDelete = (tagId: string) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;
    
    const usageCount = getTagUsageCount(tag.name);
    if (usageCount > 0) {
      if (!window.confirm(`This tag is used in ${usageCount} transaction(s). Are you sure you want to delete it?`)) {
        return;
      }
    }
    
    deleteTag(tagId);
  };

  const handleCancel = () => {
    setFormData({
      name: '',
      color: DEFAULT_TAG_COLOUR,
      description: ''
    });
    setEditingTag(null);
    setErrors({});
  };

  const predefinedColors = PREDEFINED_COLOURS;

  return (
    <PageWrapper title="Tags">

      {/* Add/Edit form — always present. The page's one job is making tags,
          so the form does not hide behind a control (owner, 29 Aug: the old
          top-right + read as dead, because this section already showed). */}
      {(
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6 mb-6">
          {/* A heading is not a link and not a state, so it takes the page's
              ink rather than a hue (stock-blue ruling, 28 Aug 2026). */}
          <h2 className="text-card font-semibold text-gray-900 dark:text-white mb-4">
            {editingTag ? 'Edit Tag' : 'Add New Tag'}
          </h2>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Tag Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className={`w-full px-3 py-2 bg-white dark:bg-gray-800 border rounded-xl focus:border-transparent dark:text-white ${
                  errors.name ? 'border-red-500/50' : 'border-gray-300/50 dark:border-gray-600/50'
                }`}
                placeholder="Enter tag name"
              />
              {errors.name && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.name}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={formData.color}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                  className="w-12 h-10 border border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer"
                />
                <div className="flex gap-1">
                  {predefinedColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setFormData({ ...formData, color })}
                      className={`w-8 h-8 rounded-lg border-2 ${
                        formData.color === color ? 'border-gray-900 dark:border-white' : 'border-gray-300 dark:border-gray-600'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description (optional)
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
                rows={3}
                placeholder="Enter tag description"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                className="flex items-center gap-2 px-4 py-2 bg-[#1a2332] text-white rounded-2xl hover:bg-[#2d3a4d] transition-colors"
              >
                <CheckIcon size={16} color="white" />
                {editingTag ? 'Update Tag' : 'Add Tag'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 bg-gray-500 text-white rounded-2xl hover:bg-gray-600 transition-colors"
              >
                <XIcon size={16} color="white" />
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tags List */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-card font-semibold text-gray-900 dark:text-white">
            All Tags ({tags.length})
          </h2>
        </div>

        {tags.length === 0 ? (
          <div className="p-8 text-center">
            <HashIcon className="mx-auto text-gray-400 mb-4" size={48} />
            <h3 className="text-card font-medium text-gray-900 dark:text-white mb-2">
              No tags yet
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              Create your first tag to start organising your transactions
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {tags.map((tag) => {
              const usageCount = getTagUsageCount(tag.name);
              return (
                <div key={tag.id} className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-4 h-4 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <div>
                        <h3 className="font-medium text-gray-900 dark:text-white">
                          {tag.name}
                        </h3>
                        {tag.description && (
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {tag.description}
                          </p>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {usageCount} transaction{usageCount !== 1 ? 's' : ''}
                      </div>
                      <div className="flex items-center gap-2">
                        <IconButton
                          onClick={() => handleEdit(tag)}
                          icon={<EditIcon size={16} />}
                          variant="ghost"
                          size="sm"
                          className="text-gray-500 hover:text-gray-700"
                        />
                        <IconButton
                          onClick={() => handleDelete(tag.id)}
                          icon={<DeleteIcon size={16} />}
                          variant="ghost"
                          size="sm"
                          className="text-gray-500 hover:text-gray-700"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Usage Statistics */}
      {tags.length > 0 && (
        <div className="mt-6 bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <h3 className="text-card font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <AlertCircleIcon size={20} />
            Tag Usage Statistics
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* A count of what exists and a count of what is in use need no
                colour — they are not asking to be looked at (stock-blue ruling,
                28 Aug 2026). The unused count keeps its amber: that one is the
                only tile with anything to act on. */}
            <div className="text-center p-4 bg-gray-50 dark:bg-gray-700/50 rounded-2xl">
              <div className="text-page font-bold text-gray-900 dark:text-white">
                {tags.length}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Total Tags
              </div>
            </div>
            <div className="text-center p-4 bg-gray-50 dark:bg-gray-700/50 rounded-2xl">
              <div className="text-page font-bold text-gray-900 dark:text-white">
                {tags.filter(tag => getTagUsageCount(tag.name) > 0).length}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Used Tags
              </div>
            </div>
            <div className="text-center p-4 bg-orange-50 dark:bg-orange-900/20 rounded-2xl">
              <div className="text-page font-bold text-orange-600 dark:text-orange-400">
                {tags.filter(tag => getTagUsageCount(tag.name) === 0).length}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Unused Tags
              </div>
            </div>
          </div>
        </div>
      )}
    </PageWrapper>
  );
}