import { CameraNode } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';
import './Styles.css';

export default function CameraEditor(props: { node: CameraNode }) {
  const [cameraState, setCameraState] = useState({
    type: props.node.camera.type,
    fov: props.node.camera.fov,
    near: props.node.camera.near,
    far: props.node.camera.far,
    left: props.node.camera.left,
    right: props.node.camera.right,
    bottom: props.node.camera.bottom,
    top: props.node.camera.top,
  });

  useEffect(() => {
    setCameraState({
      type: props.node.camera.type,
      fov: props.node.camera.fov,
      near: props.node.camera.near,
      far: props.node.camera.far,
      left: props.node.camera.left,
      right: props.node.camera.right,
      bottom: props.node.camera.bottom,
      top: props.node.camera.top,
    });
  }, [props.node]);

  useEffect(() => {
    props.node.camera.type = cameraState.type;
    props.node.camera.fov = cameraState.fov;
    props.node.camera.near = cameraState.near;
    props.node.camera.far = cameraState.far;
    props.node.camera.left = cameraState.left;
    props.node.camera.right = cameraState.right;
    props.node.camera.bottom = cameraState.bottom;
    props.node.camera.top = cameraState.top;
  }, [cameraState, props.node]);

  return (
    <Collapsable title="Camera">
      <div className="camera-editor">
        <div className="camera-table">
          <table>
            <colgroup>
              <col span={1} style={{ width: '50%' }} />
              <col span={1} style={{ width: '50%' }} />
            </colgroup>
            <tbody>
              <tr>
                <td>Type</td>
                <td>
                  <select
                    value={cameraState.type}
                    onChange={(e) =>
                      setCameraState((prev) => ({ ...prev, type: e.target.value as 'perspective' | 'orthographic' }))
                    }
                  >
                    <option value="perspective">Perspective</option>
                    <option value="orthographic">Orthographic</option>
                  </select>
                </td>
              </tr>
              {cameraState.type === 'perspective' && (
                <tr>
                  <td>Field of View</td>
                  <td>
                    <input
                      type="range"
                      min="1"
                      max="179"
                      value={cameraState.fov}
                      onChange={(e) => setCameraState((prev) => ({ ...prev, fov: parseFloat(e.target.value) }))}
                    />
                    {cameraState.fov.toFixed(2)}
                  </td>
                </tr>
              )}
              <tr>
                <td>Near</td>
                <td>
                  <input
                    type="number"
                    value={cameraState.near}
                    onChange={(e) => setCameraState((prev) => ({ ...prev, near: parseFloat(e.target.value) }))}
                  />
                </td>
              </tr>
              <tr>
                <td>Far</td>
                <td>
                  <input
                    type="number"
                    value={cameraState.far}
                    onChange={(e) => setCameraState((prev) => ({ ...prev, far: parseFloat(e.target.value) }))}
                  />
                </td>
              </tr>
              {cameraState.type === 'orthographic' && (
                <>
                  <tr>
                    <td>Left</td>
                    <td>
                      <input
                        type="number"
                        value={cameraState.left}
                        onChange={(e) => setCameraState((prev) => ({ ...prev, left: parseFloat(e.target.value) }))}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>Right</td>
                    <td>
                      <input
                        type="number"
                        value={cameraState.right}
                        onChange={(e) => setCameraState((prev) => ({ ...prev, right: parseFloat(e.target.value) }))}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>Bottom</td>
                    <td>
                      <input
                        type="number"
                        value={cameraState.bottom}
                        onChange={(e) => setCameraState((prev) => ({ ...prev, bottom: parseFloat(e.target.value) }))}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>Top</td>
                    <td>
                      <input
                        type="number"
                        value={cameraState.top}
                        onChange={(e) => setCameraState((prev) => ({ ...prev, top: parseFloat(e.target.value) }))}
                      />
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Collapsable>
  );
}
