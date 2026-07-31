"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DATA_SOURCE = `using System;
using UnityEngine;

namespace XsxbFrameTuner
{
    [Serializable] public sealed class XsxbVector { public float x; public float y; }
    [Serializable] public sealed class XsxbTransformData { public XsxbVector position; public XsxbVector scale; public float uniformScale; public float rotation; }
    [Serializable] public sealed class XsxbBoxData { public string kind; public bool enabled; public XsxbVector position; public XsxbVector size; public float rotation; }
    [Serializable] public sealed class XsxbAssetBinding { public string key; public string frameKey; public string path; public string assetPath; public string name; public string layer; public float layerOrder; public float volume; public XsxbVector offset; public XsxbVector scale; public float rotation; }
    [Serializable] public sealed class XsxbTextureData { public string path; public string assetPath; public string assetHash; public string name; public string type; public int width; public int height; public bool hasEffectiveAlpha; }
    [Serializable] public sealed class XsxbGradientStop { public string id; public float position; public string color; }
    [Serializable] public sealed class XsxbTrailStick { public string id; public int order; public int frame; public float framePhase; public string phaseMode; public bool headFrame; public string headFrameMode; public XsxbVector top; public XsxbVector bottom; public bool reverseDirection; public float directionOffset; public float tangentStrength; public string layer; }
    [Serializable] public sealed class XsxbTrailFrameSlice { public int frame; public bool enabled; public float tailProgress; public float headProgress; }
    [Serializable] public sealed class XsxbAttackTrailData { public string id; public string name; public bool enabled; public bool generated; public string profileId; public string animationId; public string coordinateSpace; public string layer; public XsxbTextureData texture; public string colorMode; public string color; public XsxbGradientStop[] gradientStops; public XsxbTrailStick[] sticks; public XsxbTrailFrameSlice[] frameSlices; public float totalDurationMs; public float tailHeadSpeedRatio; public int tailSamples; public float tailFadeStart; public float headCurvature; public float speedVariation; public int stableSeed; public int pathColumns; public int pathCacheSamples; public float collapsedWidth; }
    [Serializable] public sealed class XsxbFrameData { public int index; public string id; public string name; public string assetPath; public string sourceAssetPath; public bool bakedComposite; public XsxbVector bakedOffset; public XsxbVector bakedMainAnchor; public int width; public int height; public float durationMs; public bool disabled; public XsxbTransformData transform; public XsxbBoxData[] boxes; public XsxbAssetBinding[] audio; public XsxbAssetBinding[] attachments; }
    [Serializable] public sealed class XsxbAnimationData { public string id; public string name; public string type; public string anchorMode; public XsxbVector sourceAnchor; public float fps; public float durationMs; public XsxbFrameData[] frames; public XsxbAttackTrailData[] attackTrails; }
    [Serializable] public sealed class XsxbProfileData { public string id; public string label; public string kind; public bool sourceFacesLeft; public XsxbTransformData characterTransform; public XsxbAnimationData[] animations; }
    [Serializable] public sealed class XsxbSceneSetting { public string scene; public float scale; }
    [Serializable] public sealed class XsxbRuntimePackage { public int schemaVersion; public string authoritySchema; public string projectId; public XsxbProfileData[] profiles; public XsxbSceneSetting[] sceneSettings; }

    [Serializable] public sealed class XsxbAssetReference
    {
        public string path;
        public UnityEngine.Object asset;
    }

    [CreateAssetMenu(menuName = "XSXB/Runtime Database", fileName = "XsxbRuntimeDatabase")]
    public sealed class XsxbRuntimeDatabase : ScriptableObject
    {
        public TextAsset dataJson;
        public XsxbAssetReference[] assets = Array.Empty<XsxbAssetReference>();

        public XsxbRuntimePackage ReadPackage()
        {
            return dataJson == null ? null : JsonUtility.FromJson<XsxbRuntimePackage>(dataJson.text);
        }

        public T Load<T>(string assetPath) where T : UnityEngine.Object
        {
            if (string.IsNullOrEmpty(assetPath)) return null;
            foreach (var entry in assets)
                if (entry != null && entry.path == assetPath)
                    return entry.asset as T;
            return null;
        }
    }
}
`;

const PLAYER_SOURCE = `using System;
using UnityEngine;
using UnityEngine.Events;

namespace XsxbFrameTuner
{
    public interface IXsxbAttackTrailConsumer
    {
        void OnXsxbAttackTrailSample(XsxbFramePlayer player, XsxbAttackTrailData[] trails, float animationTimeSeconds, int frameIndex);
    }

    [DisallowMultipleComponent]
    public sealed class XsxbFramePlayer : MonoBehaviour
    {
        public XsxbRuntimeDatabase database;
        public string profileId;
        public string animationId;
        public bool autoplay = true;
        public bool loop = true;
        public bool faceLeft;
        [Min(0.0001f)] public float pixelsPerUnit = 100f;
        public Vector2 sceneScale = Vector2.one;
        [Tooltip("Scene-wide CanvasModulate tint applied after profile and frame data.")]
        public Color sceneTint = Color.white;
        [Tooltip("Godot-authored visual offset applied after the tuner profile, in source pixels.")]
        public Vector2 sceneOffsetPixels;
        [Tooltip("Godot-authored visual rotation applied after the tuner profile, in degrees.")]
        public float sceneRotationDegrees;
        [Tooltip("Keep the animation collision box as metadata/sensor when gameplay uses a canonical body collider.")]
        public bool collisionboxIsTrigger;
        public int spriteSortingOrder;
        public UnityEvent animationFinished;

        public BoxCollider2D CurrentHurtbox => _hurtbox;
        public BoxCollider2D CurrentHitbox => _hitbox;
        public BoxCollider2D CurrentCollisionbox => _collisionbox;
        public string CurrentAnimationId => _animation != null ? _animation.id : string.Empty;
        public int CurrentFrameIndex => _frameIndex;
        public float CurrentAnimationTimeSeconds => _animationClockSeconds;
        public float SceneScaleScalar => Mathf.Max(0.0001f, (Mathf.Abs(sceneScale.x) + Mathf.Abs(sceneScale.y)) * 0.5f);

        public bool TryGetCurrentAttachmentWorldPosition(
            string attachmentName,
            out Vector2 worldPosition)
        {
            worldPosition = default;
            if (_animation == null ||
                !TryGetAttachmentLocalPosition(_animation.id, _frameIndex, attachmentName, out Vector2 localPosition))
                return false;
            worldPosition = transform.TransformPoint(localPosition);
            return true;
        }

        public bool TryGetAttachmentLocalPosition(
            string targetAnimationId,
            int targetFrameIndex,
            string attachmentName,
            out Vector2 localPosition)
        {
            localPosition = default;
            if (_profile == null ||
                string.IsNullOrEmpty(targetAnimationId) ||
                string.IsNullOrEmpty(attachmentName))
                return false;
            XsxbAnimationData targetAnimation = FindAnimation(targetAnimationId);
            if (targetAnimation == null ||
                targetAnimation.frames == null ||
                targetFrameIndex < 0 ||
                targetFrameIndex >= targetAnimation.frames.Length)
                return false;
            XsxbFrameData frame = targetAnimation.frames[targetFrameIndex];
            XsxbAssetBinding targetBinding = null;
            foreach (XsxbAssetBinding binding in frame.attachments ?? Array.Empty<XsxbAssetBinding>())
            {
                if (binding != null &&
                    string.Equals(
                        binding.name,
                        attachmentName,
                        StringComparison.OrdinalIgnoreCase))
                {
                    targetBinding = binding;
                    break;
                }
            }
            if (targetBinding == null) return false;
            string sourceAssetPath = !string.IsNullOrEmpty(frame.sourceAssetPath)
                ? frame.sourceAssetPath
                : frame.assetPath;
            Sprite sprite = database != null
                ? database.Load<Sprite>(sourceAssetPath)
                : null;
            if (sprite == null) return false;

            XsxbTransformData character = _profile.characterTransform;
            XsxbTransformData groupFrame = frame.transform;
            bool mirrored = faceLeft != _profile.sourceFacesLeft;
            float mirror = mirrored ? -1f : 1f;
            float characterScalar = CharacterUniformScale(character);
            Vector3 rootPosition = new Vector3(
                (character.position.x + groupFrame.position.x + sceneOffsetPixels.x) *
                characterScalar * sceneScale.x / pixelsPerUnit * mirror,
                -(character.position.y + groupFrame.position.y + sceneOffsetPixels.y) *
                characterScalar * sceneScale.y / pixelsPerUnit,
                0f);
            Quaternion rootRotation = Quaternion.Euler(
                0f,
                0f,
                -(character.rotation + groupFrame.rotation + sceneRotationDegrees) *
                mirror);
            Vector3 rootScale = new Vector3(
                character.scale.x * groupFrame.scale.x * sceneScale.x * mirror,
                character.scale.y * groupFrame.scale.y * sceneScale.y,
                1f);
            XsxbVector offset = targetBinding.offset ?? new XsxbVector();
            Vector2 attachmentCenter =
                (Vector2)sprite.bounds.center +
                new Vector2(
                    offset.x / pixelsPerUnit,
                    -offset.y / pixelsPerUnit);
            localPosition = Matrix4x4.TRS(
                    rootPosition,
                    rootRotation,
                    rootScale)
                .MultiplyPoint3x4(attachmentCenter);
            return true;
        }

        public bool TryGetCurrentAttachmentTipWorldPosition(out Vector2 worldPosition)
        {
            return TryGetCurrentAttachmentWorldPosition(
                "rope_dart_hand_anchor.png",
                out worldPosition);
        }

        private XsxbRuntimePackage _package;
        private XsxbProfileData _profile;
        private XsxbAnimationData _animation;
        private Transform _visualRoot;
        private SpriteRenderer _sprite;
        private AudioSource _audioSource;
        private BoxCollider2D _hurtbox;
        private BoxCollider2D _hitbox;
        private BoxCollider2D _collisionbox;
        private GameObject[] _attachments = Array.Empty<GameObject>();
        private XsxbAssetBinding[] _attachmentBindings = Array.Empty<XsxbAssetBinding>();
        private int _frameIndex;
        private float _frameClockMs;
        private float _animationClockSeconds;
        private bool _playing;
        private IXsxbAttackTrailConsumer[] _trailConsumers = Array.Empty<IXsxbAttackTrailConsumer>();

        private void Awake()
        {
            EnsureAudioListener();
            EnsureNodes();
            ReloadDatabase();
            if (autoplay && !string.IsNullOrEmpty(animationId)) Play(animationId, loop, true);
        }

        public void ReloadDatabase()
        {
            _package = database != null ? database.ReadPackage() : null;
            TryApplyDatabaseSceneScale();
            _profile = FindProfile(profileId);
            if (_profile == null && _package != null && _package.profiles != null && _package.profiles.Length > 0) _profile = _package.profiles[0];
            if (_profile != null && string.IsNullOrEmpty(profileId)) profileId = _profile.id;
            _trailConsumers = GetComponentsInChildren<IXsxbAttackTrailConsumer>(true);
        }

        public bool HotReloadDatabase()
        {
            EnsureAudioListener();
            EnsureNodes();
            string preservedAnimationId = _animation != null ? _animation.id : animationId;
            bool preservedLoop = loop;
            bool preservedPlaying = _playing;
            int preservedFrameIndex = _frameIndex;
            float preservedFrameClockMs = _frameClockMs;
            float preservedAnimationClockSeconds = _animationClockSeconds;

            ReloadDatabase();
            var next = FindAnimation(preservedAnimationId);
            if (next == null || next.frames == null || next.frames.Length == 0)
            {
                _animation = null;
                _playing = false;
                return false;
            }

            animationId = preservedAnimationId;
            loop = preservedLoop;
            _animation = next;
            _frameIndex = Mathf.Clamp(preservedFrameIndex, 0, next.frames.Length - 1);
            if (next.frames[_frameIndex].disabled || next.frames[_frameIndex].durationMs <= 0f)
            {
                int playable = FirstPlayableFrame(_frameIndex);
                if (playable < 0) playable = FirstPlayableFrame(0);
                if (playable < 0)
                {
                    _playing = false;
                    return false;
                }
                _frameIndex = playable;
                preservedFrameClockMs = 0f;
            }

            _frameClockMs = Mathf.Clamp(preservedFrameClockMs, 0f, Mathf.Max(0f, next.frames[_frameIndex].durationMs - 0.001f));
            _animationClockSeconds = Mathf.Clamp(preservedAnimationClockSeconds, 0f, Mathf.Max(0f, next.durationMs / 1000f));
            _playing = preservedPlaying;
            ApplyFrame(false);
            var activeFrame = next.frames[_frameIndex];
            var character = _profile.characterTransform;
            var frameTransform = activeFrame.transform;
            Debug.Log(
                $"XSXB_HOT_RELOAD_APPLIED project={_package?.projectId} profile={_profile.id} " +
                $"animation={next.id} frame={_frameIndex} " +
                $"characterScale=({character?.scale?.x:0.#######},{character?.scale?.y:0.#######}) " +
                $"frameScale=({frameTransform?.scale?.x:0.#######},{frameTransform?.scale?.y:0.#######}) " +
                $"frameOffset=({frameTransform?.position?.x:0.#######},{frameTransform?.position?.y:0.#######}) " +
                $"sceneScale=({sceneScale.x:0.#######},{sceneScale.y:0.#######})",
                this);
            return true;
        }

        private static void EnsureAudioListener()
        {
            if (UnityEngine.Object.FindFirstObjectByType<AudioListener>() != null) return;
            var targetCamera = Camera.main != null ? Camera.main : UnityEngine.Object.FindFirstObjectByType<Camera>();
            if (targetCamera == null) return;
            var listener = targetCamera.GetComponent<AudioListener>();
            if (listener == null)
            {
                targetCamera.gameObject.AddComponent<AudioListener>();
                Debug.Log("XSXB_AUDIO_LISTENER_ADDED camera=" + targetCamera.name, targetCamera);
            }
            else if (!listener.enabled)
            {
                listener.enabled = true;
                Debug.Log("XSXB_AUDIO_LISTENER_ENABLED camera=" + targetCamera.name, targetCamera);
            }
        }

        public bool TryApplyDatabaseSceneScale(string scenePath = null)
        {
            string requestedScene = string.IsNullOrEmpty(scenePath) ? gameObject.scene.path : scenePath;
            if (string.IsNullOrEmpty(requestedScene) || _package == null || _package.sceneSettings == null)
                return false;

            foreach (var setting in _package.sceneSettings)
            {
                if (setting == null ||
                    !string.Equals(setting.scene, requestedScene, StringComparison.OrdinalIgnoreCase))
                    continue;

                float scale = Mathf.Max(0.0001f, setting.scale);
                sceneScale = Vector2.one * scale;
                Debug.Log(
                    $"XSXB_SCENE_SCALE_APPLIED scene={requestedScene} scale={scale:0.#######} shared=Sprite|Hitbox|Hurtbox|Collisionbox",
                    this);
                return true;
            }

            return false;
        }

        public bool Play(string nextAnimationId, bool shouldLoop = true, bool restart = false)
        {
            if (!restart && _animation != null && _animation.id == nextAnimationId && _playing)
            {
                loop = shouldLoop;
                return true;
            }
            var next = FindAnimation(nextAnimationId);
            if (next == null) return false;
            animationId = nextAnimationId;
            loop = shouldLoop;
            _animation = next;
            _frameIndex = FirstPlayableFrame(0);
            _frameClockMs = 0f;
            _animationClockSeconds = 0f;
            _playing = true;
            ApplyFrame(true);
            return true;
        }

        public bool RestartAnimation() => Play(animationId, loop, true);

        public float GetAnimationDurationSeconds(string requestedAnimationId)
        {
            var animation = FindAnimation(requestedAnimationId);
            return animation == null ? 0f : animation.durationMs / 1000f;
        }

        public bool IsAnimationFinished => _animation != null && !_playing;

        private void Update()
        {
            if (!_playing || _animation == null || _animation.frames == null || _animation.frames.Length == 0) return;
            float deltaMs = Time.deltaTime * 1000f;
            _frameClockMs += deltaMs;
            _animationClockSeconds += Time.deltaTime;
            int guard = _animation.frames.Length + 1;
            while (_playing && guard-- > 0)
            {
                var frame = _animation.frames[_frameIndex];
                float duration = Mathf.Max(0.001f, frame.durationMs);
                if (_frameClockMs < duration) break;
                _frameClockMs -= duration;
                AdvanceFrame();
            }
            NotifyTrails();
        }

        private void AdvanceFrame()
        {
            int next = FirstPlayableFrame(_frameIndex + 1);
            if (next >= 0)
            {
                _frameIndex = next;
                ApplyFrame(true);
                return;
            }
            if (loop)
            {
                _frameIndex = FirstPlayableFrame(0);
                _animationClockSeconds = 0f;
                ApplyFrame(true);
                return;
            }
            _playing = false;
            _frameClockMs = 0f;
            animationFinished?.Invoke();
        }

        private int FirstPlayableFrame(int start)
        {
            if (_animation == null || _animation.frames == null) return -1;
            for (int i = Mathf.Max(0, start); i < _animation.frames.Length; i++)
                if (!_animation.frames[i].disabled && _animation.frames[i].durationMs > 0f) return i;
            return -1;
        }

        private void ApplyFrame(bool playAudio)
        {
            if (_animation == null || _frameIndex < 0 || _frameIndex >= _animation.frames.Length) return;
            var frame = _animation.frames[_frameIndex];
            var nextSprite = database != null
                ? database.Load<Sprite>(frame.assetPath)
                : null;
            if (nextSprite != null)
            {
                _sprite.sprite = nextSprite;
            }
            else
            {
                Debug.LogError(
                    $"XSXB_FRAME_SPRITE_MISSING profile={profileId} " +
                    $"animation={_animation.id} frame={_frameIndex} path={frame.assetPath}",
                    this);
            }
            _sprite.color = sceneTint;
            _sprite.sortingOrder = spriteSortingOrder;
            ApplyUnifiedTransform(frame);
            ApplyBoxes(frame);
            ApplyAttachments(frame.attachments, frame.bakedComposite);
            if (playAudio) PlayAudio(frame.audio);
            if (!frame.bakedComposite) NotifyTrails();
        }

        private void ApplyUnifiedTransform(XsxbFrameData frame)
        {
            if (frame.bakedComposite)
            {
                bool bakedMirrored = faceLeft != _profile.sourceFacesLeft;
                float bakedMirror = bakedMirrored ? -1f : 1f;
                var bakedCharacter = _profile.characterTransform;
                var bakedGroupFrame = frame.transform;
                float bakedCharacterScalar = CharacterUniformScale(bakedCharacter);
                Vector3 originalRootPosition = new Vector3(
                    (bakedCharacter.position.x + bakedGroupFrame.position.x + sceneOffsetPixels.x) *
                    bakedCharacterScalar * sceneScale.x / pixelsPerUnit * bakedMirror,
                    -(bakedCharacter.position.y + bakedGroupFrame.position.y + sceneOffsetPixels.y) *
                    bakedCharacterScalar * sceneScale.y / pixelsPerUnit,
                    0f);
                Quaternion originalRootRotation = Quaternion.Euler(
                    0f,
                    0f,
                    -(bakedCharacter.rotation + bakedGroupFrame.rotation + sceneRotationDegrees) * bakedMirror);
                Vector3 originalRootScale = new Vector3(
                    bakedCharacter.scale.x * bakedGroupFrame.scale.x * sceneScale.x * bakedMirror,
                    bakedCharacter.scale.y * bakedGroupFrame.scale.y * sceneScale.y,
                    1f);
                Sprite sourceSprite = database != null
                    ? database.Load<Sprite>(frame.sourceAssetPath)
                    : null;
                Vector3 originalMainCenter = sourceSprite != null
                    ? Matrix4x4.TRS(originalRootPosition, originalRootRotation, originalRootScale)
                        .MultiplyPoint3x4(sourceSprite.bounds.center)
                    : originalRootPosition;
                var mainAnchor = frame.bakedMainAnchor ?? new XsxbVector();
                Vector2 bakedAnchorFromPivot = new Vector2(
                    mainAnchor.x * sceneScale.x * bakedMirror,
                    mainAnchor.y * sceneScale.y) / pixelsPerUnit;
                Vector2 rotatedBakedAnchor = RotateDegrees(
                    bakedAnchorFromPivot,
                    -sceneRotationDegrees * bakedMirror);
                _visualRoot.localPosition = new Vector3(
                    originalMainCenter.x - rotatedBakedAnchor.x,
                    originalMainCenter.y - rotatedBakedAnchor.y,
                    0f);
                _visualRoot.localRotation = Quaternion.Euler(0f, 0f, -sceneRotationDegrees * bakedMirror);
                _visualRoot.localScale = new Vector3(
                    sceneScale.x * bakedMirror,
                    sceneScale.y,
                    1f);
                return;
            }
            var character = _profile.characterTransform;
            var groupFrame = frame.transform;
            bool mirrored = faceLeft != _profile.sourceFacesLeft;
            float mirror = mirrored ? -1f : 1f;
            float characterScalar = CharacterUniformScale(character);
            float x = (character.position.x + groupFrame.position.x + sceneOffsetPixels.x) *
                      characterScalar * sceneScale.x / pixelsPerUnit;
            float y = -(character.position.y + groupFrame.position.y + sceneOffsetPixels.y) *
                      characterScalar * sceneScale.y / pixelsPerUnit;
            _visualRoot.localPosition = new Vector3(x * mirror, y, 0f);
            _visualRoot.localRotation = Quaternion.Euler(0f, 0f, -(character.rotation + groupFrame.rotation + sceneRotationDegrees) * mirror);
            _visualRoot.localScale = new Vector3(
                character.scale.x * groupFrame.scale.x * sceneScale.x * mirror,
                character.scale.y * groupFrame.scale.y * sceneScale.y,
                1f);
        }

        private void ApplyBoxes(XsxbFrameData frame)
        {
            ApplyBox(_hurtbox, FindBox(frame.boxes, "hurtbox"), frame);
            ApplyBox(_hitbox, FindBox(frame.boxes, "hitbox"), frame);
            ApplyGroundedCollisionBox(_collisionbox, FindBox(frame.boxes, "collisionbox"), frame);
        }

        private void ApplyBox(BoxCollider2D collider, XsxbBoxData box, XsxbFrameData frame)
        {
            if (collider == null) return;
            if (box == null || !box.enabled)
            {
                collider.enabled = false;
                return;
            }
            var character = _profile.characterTransform;
            var groupFrame = frame.transform;
            bool mirrored = faceLeft != _profile.sourceFacesLeft;
            float mirror = mirrored ? -1f : 1f;
            float characterScalar = CharacterUniformScale(character);
            Vector2 visualScale = VisualScale(character, groupFrame);
            Vector2 visualOffset = new Vector2(
                (character.position.x + groupFrame.position.x + sceneOffsetPixels.x) * characterScalar * sceneScale.x * mirror,
                (character.position.y + groupFrame.position.y + sceneOffsetPixels.y) * characterScalar * sceneScale.y);
            Vector2 localBoxOffset = new Vector2(
                box.position.x * visualScale.x * mirror,
                box.position.y * visualScale.y);
            float ownerRotation = (character.rotation + groupFrame.rotation + sceneRotationDegrees) * mirror;
            Vector2 sourcePosition = visualOffset + RotateDegrees(localBoxOffset, ownerRotation);
            collider.enabled = true;
            collider.offset = Vector2.zero;
            collider.size = new Vector2(
                Mathf.Abs(box.size.x * visualScale.x) / pixelsPerUnit,
                Mathf.Abs(box.size.y * visualScale.y) / pixelsPerUnit);
            collider.transform.localPosition = new Vector3(
                sourcePosition.x / pixelsPerUnit,
                -sourcePosition.y / pixelsPerUnit,
                0f);
            collider.transform.localRotation = Quaternion.Euler(
                0f,
                0f,
                -(character.rotation + groupFrame.rotation + sceneRotationDegrees + box.rotation) * mirror);
            collider.transform.localScale = Vector3.one;
        }

        private void ApplyGroundedCollisionBox(BoxCollider2D collider, XsxbBoxData box, XsxbFrameData frame)
        {
            if (collider == null) return;
            if (box == null || !box.enabled)
            {
                collider.enabled = false;
                return;
            }
            var character = _profile.characterTransform;
            var groupFrame = frame.transform;
            bool mirrored = faceLeft != _profile.sourceFacesLeft;
            float mirror = mirrored ? -1f : 1f;
            float characterScalar = CharacterUniformScale(character);
            Vector2 visualScale = VisualScale(character, groupFrame);
            Vector2 visualOffset = new Vector2(
                (character.position.x + groupFrame.position.x + sceneOffsetPixels.x) * characterScalar * sceneScale.x * mirror,
                (character.position.y + groupFrame.position.y + sceneOffsetPixels.y) * characterScalar * sceneScale.y);
            Vector2 localBoxOffset = new Vector2(
                box.position.x * visualScale.x * mirror,
                box.position.y * visualScale.y);
            float ownerRotation = (character.rotation + groupFrame.rotation + sceneRotationDegrees) * mirror;
            Vector2 sourcePosition = visualOffset + RotateDegrees(localBoxOffset, ownerRotation);
            Vector2 colliderSize = new Vector2(
                Mathf.Abs(box.size.x * visualScale.x) / pixelsPerUnit,
                Mathf.Abs(box.size.y * visualScale.y) / pixelsPerUnit);
            collider.enabled = true;
            collider.offset = Vector2.zero;
            collider.size = colliderSize;
            collider.transform.localPosition = new Vector3(
                sourcePosition.x / pixelsPerUnit,
                colliderSize.y * 0.5f,
                0f);
            collider.transform.localRotation = Quaternion.identity;
            collider.transform.localScale = Vector3.one;
        }

        private static float CharacterUniformScale(XsxbTransformData character)
        {
            if (character == null) return 1f;
            if (character.uniformScale > 0.0001f) return character.uniformScale;
            if (character.scale != null && character.scale.x > 0.0001f) return character.scale.x;
            return 1f;
        }

        private Vector2 VisualScale(XsxbTransformData character, XsxbTransformData groupFrame)
        {
            float characterX = character?.scale != null ? character.scale.x : 1f;
            float characterY = character?.scale != null ? character.scale.y : 1f;
            float frameX = groupFrame?.scale != null ? groupFrame.scale.x : 1f;
            float frameY = groupFrame?.scale != null ? groupFrame.scale.y : 1f;
            return new Vector2(
                Mathf.Abs(characterX * frameX * sceneScale.x),
                Mathf.Abs(characterY * frameY * sceneScale.y));
        }

        private static Vector2 RotateDegrees(Vector2 value, float degrees)
        {
            float radians = degrees * Mathf.Deg2Rad;
            float cos = Mathf.Cos(radians);
            float sin = Mathf.Sin(radians);
            return new Vector2(value.x * cos - value.y * sin, value.x * sin + value.y * cos);
        }

        private void ApplyAttachments(XsxbAssetBinding[] bindings, bool suppressRendering = false)
        {
            foreach (var item in _attachments) if (item != null) Destroy(item);
            if (bindings == null)
            {
                _attachments = Array.Empty<GameObject>();
                _attachmentBindings = Array.Empty<XsxbAssetBinding>();
                return;
            }
            _attachmentBindings = bindings;
            if (suppressRendering)
            {
                _attachments = Array.Empty<GameObject>();
                return;
            }
            bool hasRenderableAttachment = false;
            foreach (var binding in bindings)
            {
                if (!IsMarkerOnlyAttachment(binding))
                {
                    hasRenderableAttachment = true;
                    break;
                }
            }
            if (!hasRenderableAttachment)
            {
                _attachments = Array.Empty<GameObject>();
                return;
            }
            _attachments = new GameObject[bindings.Length];
            for (int i = 0; i < bindings.Length; i++)
            {
                var binding = bindings[i];
                if (IsMarkerOnlyAttachment(binding))
                {
                    // Marker-only attachments are queried directly from their
                    // authored binding. Avoid creating and destroying a hidden
                    // GameObject every animation frame.
                    _attachments[i] = null;
                    continue;
                }
                var sprite = database.Load<Sprite>(AssetPath(binding));
                if (sprite == null) continue;
                var node = new GameObject(
                    "XSXB Attachment " +
                    (!string.IsNullOrEmpty(binding.name) ? binding.name : i.ToString()));
                node.transform.SetParent(_visualRoot, false);
                var offset = binding.offset ?? new XsxbVector();
                var authoredScale = binding.scale ?? new XsxbVector { x = 1f, y = 1f };
                node.transform.localPosition = new Vector3(offset.x / pixelsPerUnit, -offset.y / pixelsPerUnit, 0f);
                node.transform.localRotation = Quaternion.Euler(0f, 0f, -binding.rotation);
                node.transform.localScale = new Vector3(authoredScale.x == 0 ? 1 : authoredScale.x, authoredScale.y == 0 ? 1 : authoredScale.y, 1f);
                var renderer = node.AddComponent<SpriteRenderer>();
                renderer.sprite = sprite;
                renderer.enabled = true;
                int layerOffset = binding.layerOrder != 0f
                    ? Mathf.RoundToInt(binding.layerOrder)
                    : (binding.layer == "below" || binding.layer == "behind" ? -1 : 1);
                renderer.sortingOrder = spriteSortingOrder + layerOffset;
                _attachments[i] = node;
            }
        }

        private static bool IsMarkerOnlyAttachment(XsxbAssetBinding binding)
        {
            return binding != null &&
                   !string.IsNullOrEmpty(binding.name) &&
                   binding.name.EndsWith(
                       "_hand_anchor.png",
                       StringComparison.OrdinalIgnoreCase);
        }

        private void PlayAudio(XsxbAssetBinding[] bindings)
        {
            if (bindings == null) return;
            foreach (var binding in bindings)
            {
                var clip = database.Load<AudioClip>(AssetPath(binding));
                if (clip != null) _audioSource.PlayOneShot(clip, binding.volume > 0f ? binding.volume : 1f);
            }
        }

        private void NotifyTrails()
        {
            var trails = _animation != null ? _animation.attackTrails : null;
            foreach (var consumer in _trailConsumers)
                consumer?.OnXsxbAttackTrailSample(this, trails ?? Array.Empty<XsxbAttackTrailData>(), _animationClockSeconds, _frameIndex);
        }

        private XsxbProfileData FindProfile(string id)
        {
            if (_package == null || _package.profiles == null) return null;
            foreach (var item in _package.profiles) if (item.id == id) return item;
            return null;
        }

        private XsxbAnimationData FindAnimation(string id)
        {
            if (_profile == null || _profile.animations == null) return null;
            foreach (var item in _profile.animations) if (item.id == id || item.name == id) return item;
            return null;
        }

        private static XsxbBoxData FindBox(XsxbBoxData[] boxes, string kind)
        {
            if (boxes != null) foreach (var item in boxes) if (item.kind == kind) return item;
            return null;
        }

        private static string AssetPath(XsxbAssetBinding binding) => string.IsNullOrEmpty(binding.assetPath) ? binding.path : binding.assetPath;

        private void EnsureNodes()
        {
            if (_visualRoot == null)
            {
                _visualRoot = transform.Find("XSXB Visual Root");
                if (_visualRoot == null)
                {
                    _visualRoot = new GameObject("XSXB Visual Root").transform;
                    _visualRoot.SetParent(transform, false);
                }
            }
            _sprite = _visualRoot.GetComponent<SpriteRenderer>();
            if (_sprite == null) _sprite = _visualRoot.gameObject.AddComponent<SpriteRenderer>();
            _audioSource = gameObject.GetComponent<AudioSource>();
            if (_audioSource == null) _audioSource = gameObject.AddComponent<AudioSource>();
            _hurtbox = EnsureBox("XSXB Hurtbox", true);
            _hitbox = EnsureBox("XSXB Hitbox", true);
            _collisionbox = EnsureBox("XSXB Collisionbox", collisionboxIsTrigger);
        }

        private BoxCollider2D EnsureBox(string name, bool trigger)
        {
            var child = transform.Find(name);
            if (child == null) child = _visualRoot.Find(name);
            if (child == null)
            {
                child = new GameObject(name).transform;
            }
            child.SetParent(transform, false);
            child.localPosition = Vector3.zero;
            child.localRotation = Quaternion.identity;
            child.localScale = Vector3.one;
            var collider = child.GetComponent<BoxCollider2D>();
            if (collider == null) collider = child.gameObject.AddComponent<BoxCollider2D>();
            if (collider == null) return null;
            collider.isTrigger = trigger;
            return collider;
        }
    }
}
`;

const IMPORTER_SOURCE = `#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace XsxbFrameTuner.Editor
{
    public sealed class XsxbRuntimeImporter : AssetPostprocessor
    {
        private const string Root = "Assets/XSXBFrameTuner/";
        private static bool rebuildScheduled;
        private static bool rebuilding;
        private static double nextSignalPollAt;
        private static readonly Dictionary<string, string> signalStamps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        [InitializeOnLoadMethod]
        private static void ScheduleInitialRebuild()
        {
            SnapshotSyncSignals();
            EditorApplication.update -= PollSyncSignals;
            EditorApplication.update += PollSyncSignals;
            ScheduleRebuild();
        }

        private static void ScheduleRebuild()
        {
            if (rebuilding || rebuildScheduled) return;
            rebuildScheduled = true;
            EditorApplication.delayCall += () =>
            {
                rebuildScheduled = false;
                RebuildAll();
            };
        }

        private static string AbsoluteRoot()
        {
            return Path.Combine(Path.GetDirectoryName(Application.dataPath), Root.TrimEnd('/'));
        }

        private static string SignalStamp(string filePath)
        {
            var info = new FileInfo(filePath);
            return info.LastWriteTimeUtc.Ticks + ":" + info.Length;
        }

        private static void SnapshotSyncSignals()
        {
            var root = AbsoluteRoot();
            if (!Directory.Exists(root)) return;
            foreach (var filePath in Directory.GetFiles(root, "xsxb_sync_signal.json", SearchOption.AllDirectories))
                signalStamps[filePath] = SignalStamp(filePath);
        }

        private static void PollSyncSignals()
        {
            if (EditorApplication.timeSinceStartup < nextSignalPollAt) return;
            nextSignalPollAt = EditorApplication.timeSinceStartup + 0.75d;
            if (rebuilding || rebuildScheduled || EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            var root = AbsoluteRoot();
            if (!Directory.Exists(root)) return;
            bool changed = false;
            foreach (var filePath in Directory.GetFiles(root, "xsxb_sync_signal.json", SearchOption.AllDirectories))
            {
                var stamp = SignalStamp(filePath);
                if (!signalStamps.TryGetValue(filePath, out var previous) || previous != stamp) changed = true;
                signalStamps[filePath] = stamp;
            }
            if (changed)
            {
                Debug.Log("XSXB runtime data changed; references are maintained by the Frame Tuner sync.");
                ScheduleRebuild();
            }
        }

        private void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith(Root, StringComparison.Ordinal)) return;
            if (!assetPath.Contains("/Frames/") && !assetPath.Contains("/BakedFrames/") && !assetPath.Contains("/Attachments/") && !assetPath.Contains("/AttackTrails/")) return;
            var importer = (TextureImporter)assetImporter;
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = 100f;
            var textureSettings = new TextureImporterSettings();
            importer.ReadTextureSettings(textureSettings);
            textureSettings.spriteAlignment = (int)SpriteAlignment.Custom;
            textureSettings.spritePivot = new Vector2(0.5f, 0f);
            importer.SetTextureSettings(textureSettings);
            importer.alphaIsTransparency = true;
            importer.mipmapEnabled = false;
            importer.filterMode = FilterMode.Bilinear;
        }

        private static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            foreach (var item in imported)
            {
                if (!item.StartsWith(Root, StringComparison.Ordinal)) continue;
                if (!item.EndsWith("xsxb_runtime_data.json", StringComparison.OrdinalIgnoreCase)
                    && !item.Contains("/Frames/")
                    && !item.Contains("/BakedFrames/")
                    && !item.Contains("/Audio/")
                    && !item.Contains("/Attachments/")
                    && !item.Contains("/AttackTrails/")) continue;
                SnapshotSyncSignals();
                ScheduleRebuild();
                break;
            }
        }

        [MenuItem("Tools/XSXB/Rebuild Runtime Databases")]
        public static void RebuildAll()
        {
            if (rebuilding) return;
            rebuilding = true;
            try
            {
                var runtimeDatabases = new List<XsxbRuntimeDatabase>();
                foreach (var guid in AssetDatabase.FindAssets("xsxb_runtime_data t:TextAsset", new[] { Root.TrimEnd('/') }))
                {
                    var jsonPath = AssetDatabase.GUIDToAssetPath(guid);
                    var json = AssetDatabase.LoadAssetAtPath<TextAsset>(jsonPath);
                    if (json == null) continue;
                    var databasePath = Path.ChangeExtension(jsonPath, ".asset");
                    var database = AssetDatabase.LoadAssetAtPath<XsxbRuntimeDatabase>(databasePath);
                    if (database == null)
                    {
                        database = ScriptableObject.CreateInstance<XsxbRuntimeDatabase>();
                        AssetDatabase.CreateAsset(database, databasePath);
                    }
                    database.dataJson = json;
                    var references = new List<XsxbAssetReference>();
                    var existingReferences = new Dictionary<string, XsxbAssetReference>(StringComparer.Ordinal);
                    foreach (var existing in database.assets ?? Array.Empty<XsxbAssetReference>())
                    {
                        if (existing == null || string.IsNullOrEmpty(existing.path)) continue;
                        existingReferences[existing.path] = existing;
                    }
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (Match match in Regex.Matches(json.text, "\\\"(?:assetPath|sourceAssetPath)\\\"\\\\s*:\\\\s*\\\"(Assets/[^\\\"]+)\\\""))
                    {
                        var assetPath = match.Groups[1].Value.Replace("\\\\", "/");
                        if (!seen.Add(assetPath)) continue;
                        if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(assetPath)))
                        {
                            var absoluteAssetPath = Path.Combine(
                                Path.GetDirectoryName(Application.dataPath),
                                assetPath.Replace('/', Path.DirectorySeparatorChar));
                            if (File.Exists(absoluteAssetPath))
                                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
                        }
                        if (existingReferences.TryGetValue(assetPath, out var existing) &&
                            existing.asset != null)
                        {
                            references.Add(existing);
                            continue;
                        }
                        UnityEngine.Object asset = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
                        if (asset == null) asset = AssetDatabase.LoadAssetAtPath<AudioClip>(assetPath);
                        if (asset == null) asset = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
                        if (asset != null) references.Add(new XsxbAssetReference { path = assetPath, asset = asset });
                    }
                    database.assets = references.ToArray();
                    EditorUtility.SetDirty(database);
                    runtimeDatabases.Add(database);
                }
                AssetDatabase.SaveAssets();
                SnapshotSyncSignals();
                HotReloadPlayers(runtimeDatabases);
                Debug.Log(
                    "XSXB_RUNTIME_REBUILD_OK databases=" + runtimeDatabases.Count +
                    " playing=" + EditorApplication.isPlaying);
            }
            finally
            {
                rebuilding = false;
            }
        }

        private static void HotReloadPlayers(IReadOnlyList<XsxbRuntimeDatabase> runtimeDatabases)
        {
            if (!EditorApplication.isPlaying) return;
            foreach (var player in UnityEngine.Object.FindObjectsByType<XsxbFramePlayer>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None))
            {
                if (player == null) continue;
                try
                {
                    var currentPackage = player.database != null ? player.database.ReadPackage() : null;
                    var preferredProjectId = currentPackage != null ? currentPackage.projectId : string.Empty;
                    var runtimeDatabase = ResolveDatabaseForProfile(
                        runtimeDatabases,
                        player.profileId,
                        preferredProjectId);
                    if (runtimeDatabase != null && player.database != runtimeDatabase)
                    {
                        player.database = runtimeDatabase;
                        Debug.Log(
                            "XSXB_RUNTIME_DATABASE_REBOUND player=" + player.name +
                            " profile=" + player.profileId +
                            " database=" + AssetDatabase.GetAssetPath(runtimeDatabase),
                            player);
                    }
                    player.HotReloadDatabase();
                }
                catch (Exception error)
                {
                    Debug.LogWarning("XSXB hot reload skipped for " + player.name + ": " + error.Message, player);
                }
            }
        }

        private static XsxbRuntimeDatabase ResolveDatabaseForProfile(
            IReadOnlyList<XsxbRuntimeDatabase> runtimeDatabases,
            string profileId,
            string preferredProjectId)
        {
            if (runtimeDatabases == null || string.IsNullOrEmpty(profileId)) return null;
            XsxbRuntimeDatabase fallback = null;
            foreach (var database in runtimeDatabases)
            {
                var package = database != null ? database.ReadPackage() : null;
                if (package?.profiles == null) continue;
                bool containsProfile = false;
                foreach (var profile in package.profiles)
                {
                    if (profile != null && string.Equals(profile.id, profileId, StringComparison.Ordinal))
                    {
                        containsProfile = true;
                        break;
                    }
                }
                if (!containsProfile) continue;
                if (!string.IsNullOrEmpty(preferredProjectId) &&
                    string.Equals(package.projectId, preferredProjectId, StringComparison.Ordinal))
                    return database;
                if (fallback == null) fallback = database;
            }
            return fallback;
        }

        public static void BatchSmoke()
        {
            RebuildAll();
            var databases = AssetDatabase.FindAssets("t:XsxbRuntimeDatabase", new[] { Root.TrimEnd('/') });
            if (databases.Length == 0) throw new InvalidOperationException("No XSXB runtime database was generated.");
            int spriteFrames = 0;
            int audioClips = 0;
            foreach (var guid in databases)
            {
                var database = AssetDatabase.LoadAssetAtPath<XsxbRuntimeDatabase>(AssetDatabase.GUIDToAssetPath(guid));
                var package = database != null ? database.ReadPackage() : null;
                if (package == null || package.profiles == null || package.profiles.Length == 0)
                    throw new InvalidOperationException("XSXB runtime database contains no profiles.");
                var referencePaths = new HashSet<string>(StringComparer.Ordinal);
                foreach (var reference in database.assets ?? Array.Empty<XsxbAssetReference>())
                    if (reference != null &&
                        reference.asset != null &&
                        !string.IsNullOrEmpty(reference.path))
                        referencePaths.Add(reference.path);
                foreach (var profile in package.profiles)
                foreach (var animation in profile.animations ?? Array.Empty<XsxbAnimationData>())
                foreach (var frame in animation.frames ?? Array.Empty<XsxbFrameData>())
                {
                    if (string.IsNullOrEmpty(frame.assetPath)) continue;
                    spriteFrames++;
                    if (!referencePaths.Contains(frame.assetPath) ||
                        string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(frame.assetPath)))
                        throw new InvalidOperationException("XSXB database is missing Sprite reference: " + profile.id + "/" + animation.id + ":" + frame.index + " -> " + frame.assetPath);
                    foreach (var audio in frame.audio ?? Array.Empty<XsxbAssetBinding>())
                    {
                        var audioPath = !string.IsNullOrEmpty(audio.assetPath) ? audio.assetPath : audio.path;
                        if (string.IsNullOrEmpty(audioPath))
                            throw new InvalidOperationException("XSXB frame audio binding has no asset path: " + profile.id + "/" + animation.id + ":" + frame.index);
                        audioClips++;
                        if (!referencePaths.Contains(audioPath) ||
                            string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(audioPath)))
                            throw new InvalidOperationException("XSXB database is missing AudioClip reference: " + profile.id + "/" + animation.id + ":" + frame.index + " -> " + audioPath);
                    }
                }
            }
            if (spriteFrames == 0) throw new InvalidOperationException("XSXB runtime database contains no Sprite frames.");
            Debug.Log("XSXB_UNITY_SMOKE_OK databases=" + databases.Length + " spriteFrames=" + spriteFrames + " audioClips=" + audioClips);
        }
    }
}
#endif
`;

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function ensureUnityRuntime(projectRoot) {
  const runtimeRoot = path.join(projectRoot, "Assets", "XSXBFrameTuner", "Runtime");
  const legacyDataFile = path.join(runtimeRoot, "XsxbRuntimeData.cs");
  let removedLegacyDataFile = false;
  if (fs.existsSync(legacyDataFile)) {
    fs.unlinkSync(legacyDataFile);
    removedLegacyDataFile = true;
  }
  const files = [
    [path.join(runtimeRoot, "XsxbRuntimeDatabase.cs"), DATA_SOURCE],
    [path.join(runtimeRoot, "XsxbFramePlayer.cs"), PLAYER_SOURCE],
    [path.join(runtimeRoot, "Editor", "XsxbRuntimeImporter.cs"), IMPORTER_SOURCE],
  ];
  return {
    runtimeRoot,
    removedLegacyDataFile,
    files: files.map(([filePath, content]) => ({ filePath, changed: writeIfChanged(filePath, content) })),
  };
}

module.exports = { ensureUnityRuntime };
